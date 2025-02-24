const pdfjsPath = path => new URL(`vendor/pdfjs/${path}`, import.meta.url).toString()

import './vendor/pdfjs/pdf.mjs'
const pdfjsLib = globalThis.pdfjsLib
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsPath('pdf.worker.mjs')

const flatten = (items, level = 0) => items
    .map(item => item.subitems?.length
        ? [{ ...item, level }, flatten(item.subitems, level + 1)].flat()
        : { ...item, level })
    .flat()

const fetchText = async url => await (await fetch(url)).text()

// https://github.com/mozilla/pdf.js/blob/642b9a5ae67ef642b9a8808fd9efd447e8c350e2/web/text_layer_builder.css
const textLayerBuilderCSS = await fetchText(pdfjsPath('text_layer_builder.css'))

// https://github.com/mozilla/pdf.js/blob/642b9a5ae67ef642b9a8808fd9efd447e8c350e2/web/annotation_layer_builder.css
const annotationLayerBuilderCSS = await fetchText(pdfjsPath('annotation_layer_builder.css'))

const render = async (page, doc, zoom, pdfDoc) => {
    const scale = zoom * devicePixelRatio
    doc.documentElement.style.transform = `scale(${1 / devicePixelRatio})`
    doc.documentElement.style.transformOrigin = 'top left'
    doc.documentElement.style.setProperty('--scale-factor', scale)
    const viewport = page.getViewport({ scale })

    // the canvas must be in the `PDFDocument`'s `ownerDocument`
    // (`globalThis.document` by default); that's where the fonts are loaded
    const canvas = document.createElement('canvas')
    canvas.height = viewport.height
    canvas.width = viewport.width
    const canvasContext = canvas.getContext('2d')
    await page.render({ canvasContext, viewport }).promise
    doc.querySelector('#canvas').replaceChildren(doc.adoptNode(canvas))

    const container = doc.querySelector('.textLayer')
    const textLayer = new pdfjsLib.TextLayer({
        textContentSource: await page.streamTextContent(),
        container, viewport,
    })
    await textLayer.render()

    // hide "offscreen" canvases appended to docuemnt when rendering text layer
    // https://github.com/mozilla/pdf.js/blob/642b9a5ae67ef642b9a8808fd9efd447e8c350e2/web/pdf_viewer.css#L51-L58
    for (const canvas of document.querySelectorAll('.hiddenCanvasElement'))
        Object.assign(canvas.style, {
            position: 'absolute',
            top: '0',
            left: '0',
            width: '0',
            height: '0',
            display: 'none',
        })

    // fix text selection
    // https://github.com/mozilla/pdf.js/blob/642b9a5ae67ef642b9a8808fd9efd447e8c350e2/web/text_layer_builder.js#L105-L107
    const endOfContent = document.createElement('div')
    endOfContent.className = 'endOfContent'
    container.append(endOfContent)
    // TODO: this only works in Firefox; see https://github.com/mozilla/pdf.js/pull/17923
    container.onpointerdown = () => container.classList.add('selecting')
    container.onpointerup = () => container.classList.remove('selecting')

    const div = doc.querySelector('.annotationLayer')
    await new pdfjsLib.AnnotationLayer({ page, viewport, div }).render({
        annotations: await page.getAnnotations(),
        linkService: {
            goToDestination: () => { },
            getDestinationHash: dest => JSON.stringify(dest),
            addLinkAttributes: (link, url) => link.href = url,
        },
    })

    // Send page change event
    window.parent.postMessage({
        type: 'reader:page-changed',
        data: {
            currentPage: page.pageNumber,
            totalPages: pdfDoc.numPages
        }
    }, '*')
}

const renderPage = async (page, getImageBlob, pdfDoc) => {
    const viewport = page.getViewport({ scale: 1 })
    if (getImageBlob) {
        const canvas = document.createElement('canvas')
        canvas.height = viewport.height
        canvas.width = viewport.width
        const canvasContext = canvas.getContext('2d')
        await page.render({ canvasContext, viewport }).promise
        return new Promise(resolve => canvas.toBlob(resolve))
    }
    const src = URL.createObjectURL(new Blob([`
        <!DOCTYPE html>
        <html lang="en">
        <meta charset="utf-8">
        <meta name="viewport" content="width=${viewport.width}, height=${viewport.height}">
        <style>
        html, body {
            margin: 0;
            padding: 0;
        }
        ${textLayerBuilderCSS}
        ${annotationLayerBuilderCSS}
        </style>
        <div id="canvas"></div>
        <div class="textLayer"></div>
        <div class="annotationLayer"></div>
    `], { type: 'text/html' }))
    const onZoom = ({ doc, scale }) => render(page, doc, scale, pdfDoc)
    return { src, onZoom }
}

const makeTOCItem = item => ({
    label: item.title,
    href: item.dest ? JSON.stringify(item.dest) : null,
    subitems: item.items.length ? item.items.filter(e => e && e.dest).map(makeTOCItem) : null,
})

export const makePDF = async file => {
    const transport = new pdfjsLib.PDFDataRangeTransport(file.size, [])
    transport.requestDataRange = (begin, end) => {
        file.slice(begin, end).arrayBuffer().then(chunk => {
            transport.onDataRange(begin, chunk)
        })
    }
    const pdf = await pdfjsLib.getDocument({
        range: transport,
        cMapUrl: pdfjsPath('cmaps/'),
        standardFontDataUrl: pdfjsPath('standard_fonts/'),
        isEvalSupported: false,
    }).promise

    // Send loaded event
    window.parent.postMessage({
        type: 'reader:loaded',
        data: {}
    }, '*')

    const book = { rendition: { layout: 'pre-paginated', pdf, isPdf: true }, contentMap: new Map() }

    const { metadata, info } = await pdf.getMetadata() ?? {}
    // TODO: for better results, parse `metadata.getRaw()`
    book.metadata = {
        title: metadata?.get('dc:title') ?? info?.Title,
        author: metadata?.get('dc:creator') ?? info?.Author,
        contributor: metadata?.get('dc:contributor'),
        description: metadata?.get('dc:description') ?? info?.Subject,
        language: metadata?.get('dc:language'),
        publisher: metadata?.get('dc:publisher'),
        subject: metadata?.get('dc:subject'),
        identifier: metadata?.get('dc:identifier'),
        source: metadata?.get('dc:source'),
        rights: metadata?.get('dc:rights'),
    }

    const outline = await pdf.getOutline()
    book.toc = outline?.filter(e => e && e.dest)?.map(makeTOCItem)

    const cache = new Map()
    const getIndexContent = async index => {
        try {
            const page = await pdf.getPage(index + 1)
            const textContent = await page.getTextContent({
                includeMarkedContent: true,
                disableNormalization: true
            })

            // Filter valid items and group by vertical position
            const validItems = textContent.items.filter(item =>
                item.str &&
                Array.isArray(item.transform) &&
                item.transform.length >= 6
            )

            if (validItems.length === 0) {
                return `
                ----- page:${index} start -----
                [No readable text content found on this page]
                ----- page:${index} end -----
                \n`
            }

            // Group items by vertical position to maintain reading order
            const lines = []
            let currentY
            let currentLine = []

            validItems.forEach(item => {
                const y = item.transform[5] // vertical position
                if (currentY === undefined || Math.abs(currentY - y) > 5) {
                    if (currentLine.length > 0) {
                        lines.push(currentLine)
                    }
                    currentLine = [item]
                    currentY = y
                } else {
                    currentLine.push(item)
                }
            })
            if (currentLine.length > 0) {
                lines.push(currentLine)
            }

            // Sort lines from top to bottom and combine items in each line
            const pageText = lines
                .sort((a, b) => b[0].transform[5] - a[0].transform[5]) // Sort by Y position
                .map(line =>
                    line
                        .sort((a, b) => a.transform[4] - b.transform[4]) // Sort by X position within line
                        .map(item => item.str)
                        .join(' ')
                )
                .join('\n')

            return `
                ----- page:${index} start -----
                ${pageText}
                ----- page:${index} end -----
                \n`
        } catch (error) {
            return ''
        }
    }

    book.sections = Array.from({ length: pdf.numPages }).map((_, i) => ({
        id: i,
        load: async () => {
            const cached = cache.get(i)
            if (cached) return cached
            const url = await renderPage(await pdf.getPage(i + 1), false, pdf)
            cache.set(i, url)
            return url
        },
        async getPage() {
            return await pdf.getPage(i + 1)
        },
        loadText: async () => getIndexContent(i),
        size: 1000,
    }))
    book.isExternal = uri => /^\w+:/i.test(uri)
    book.resolveHref = async href => {
        try {
            const parsed = JSON.parse(href)
            const dest = typeof parsed === 'string'
                ? await pdf.getDestination(parsed) : parsed
            const index = await pdf.getPageIndex(dest[0])
            return { index }
        } catch (error) {
            console.error('resolveHref error', error)
        }
    }
    book.splitTOCHref = async href => {
        try {
            const parsed = JSON.parse(href)
            const dest = typeof parsed === 'string'
                ? await pdf.getDestination(parsed) : parsed
            const index = await pdf.getPageIndex(dest[0])
            return [index, null]
        } catch (error) {
            console.error('splitTOCHref error', error)
        }
    }
    book.getHrefIndex = async href => {
        try {
            const parsed = JSON.parse(href)
            const dest = typeof parsed === 'string'
                ? await pdf.getDestination(parsed) : parsed
            const index = await pdf.getPageIndex(dest[0])
            return index
        } catch (error) {
            console.error('getHrefIndex error', error)
        }
    }
    book.getTOCFragment = doc => doc.documentElement
    book.getCover = async () => renderPage(await pdf.getPage(1), true, pdf)
    book.destroy = () => pdf.destroy()
    const getIndexList = async () => {
        if (book.toc && book.toc.length > 1) {
            const flattenToc = flatten(book.toc) || []
            // console.log('flattenToc', flattenToc)
            if (Array.isArray(flattenToc) && flattenToc.some(e => e.level === 1 || e.level === 2)) {
                const tocs = flattenToc.filter(item => item.level === 2 || (item.level <= 1 && !item.subitems?.length))
                const indexList = await Promise.all(tocs.map(async item => ({
                    ...item,
                    index: await book.getHrefIndex(item.href),
                    url: JSON.parse(item.href)
                })))
                // console.log('indexList', indexList)
                return indexList
            } else {
                const indexList = await Promise.all(flattenToc.map(async item => ({
                    ...item,
                    index: await book.getHrefIndex(item.href),
                    url: JSON.parse(item.href)
                })))
                // console.log('indexList', indexList)
                return indexList
            }
        }
        // 没有toc，则返回每10页一节
        const indexList = []
        for (let i = 0; i < pdf.numPages; i += 10) {
            const start = i + 10
            indexList.push({
                index: start,
                url: `page:${start}`,
                level: 2,
            })
        }
        console.log('indexList', indexList)
        return indexList
    }
    book.getIndexList = getIndexList(book.toc)
    book.getTocContent = async toc => {
        if (!toc) return ''
        const { start, end, path } = toc
        if (book.contentMap.has(path)) return book.contentMap.get(path)
        let content = ''
        for (let i = start; i < end; i++) {
            const pageContent = await getIndexContent(i)
            content += pageContent
        }
        book.contentMap.set(path, content)
        return content
    }
    book.getTocIndex = async index => {
        return book.getIndexList.then(indexList => {
            for (let i = 0; i < indexList.length; i++) {
                const start = indexList[i]?.index ?? 0
                const end = indexList[i + 1]?.index ?? 0
                if (index < start) {
                    const ret = { start: 0, end: Math.max(start - 1, 0) }
                    return { ...ret, path: `page:0-${ret.end}` }
                }
                if (index >= start && index < end) {
                    const path = `page:${start}-${end}`
                    return {
                        ...indexList[i],
                        path,
                        start,
                        end
                    }
                }
            }
        })
    }
    book.getNextChapterIndex = async (index) => {
        return book.getIndexList.then(indexList => {
            for (let i = 0; i < indexList.length; i++) {
                const current = indexList[i]
                const next = indexList[i + 1]
                const start = current?.index ?? 0
                const end = next?.index ?? 0
                if (i === 0 && index < start) {
                    return { index: start }
                }
                if (index >= start && index < end) {
                    return { index: end }
                }
            }
        })
    }
    book.getPrevChapterIndex = async (index) => {
        return book.getIndexList.then(indexList => {
            for (let i = 0; i < indexList.length; i++) {
                const prev = indexList[i - 1]
                const current = indexList[i]
                const start = prev?.index ?? 0
                const end = current?.index ?? 0
                if (index > start && index <= end) {
                    return { index: start }
                }
            }
        })
    }
    return book
}
