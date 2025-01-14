// 导入必需的模块
import * as CFI from './epubcfi.js'
import { TOCProgress, SectionProgress } from './progress.js'
import { Overlayer } from './overlayer.js'
import { textWalker } from './text-walker.js'

// 搜索结果的前缀标识符
const SEARCH_PREFIX = 'foliate-search:'

const contentMap = new Map()


const flatten = items => items
    .map(item => item.subitems?.length
        ? [item, flatten(item.subitems)].flat()
        : item)
    .flat()

// 检查文件是否为ZIP格式（通过文件头部魔数判断）
const isZip = async file => {
    const arr = new Uint8Array(await file.slice(0, 4).arrayBuffer())
    return arr[0] === 0x50 && arr[1] === 0x4b && arr[2] === 0x03 && arr[3] === 0x04
}

// 检查文件是否为PDF格式（通过文件头部魔数判断）
const isPDF = async file => {
    const arr = new Uint8Array(await file.slice(0, 5).arrayBuffer())
    return arr[0] === 0x25
        && arr[1] === 0x50 && arr[2] === 0x44 && arr[3] === 0x46
        && arr[4] === 0x2d
}

// 检查文件是否为CBZ格式（漫画书格式）
const isCBZ = ({ name, type }) =>
    type === 'application/vnd.comicbook+zip' || name.endsWith('.cbz')

// 检查文件是否为FB2格式（FictionBook格式）
const isFB2 = ({ name, type }) =>
    type === 'application/x-fictionbook+xml' || name.endsWith('.fb2')

// 检查文件是否为压缩的FB2格式
const isFBZ = ({ name, type }) =>
    type === 'application/x-zip-compressed-fb2'
    || name.endsWith('.fb2.zip') || name.endsWith('.fbz')

// 创建ZIP文件加载器，用于处理压缩文件的读取
const makeZipLoader = async file => {
    const { configure, ZipReader, BlobReader, TextWriter, BlobWriter } =
        await import('./vendor/zip.js')
    configure({ useWebWorkers: false })
    const reader = new ZipReader(new BlobReader(file))
    const entries = await reader.getEntries()
    const map = new Map(entries.map(entry => [entry.filename, entry]))
    const load = f => (name, ...args) =>
        map.has(name) ? f(map.get(name), ...args) : null
    const loadText = load(entry => entry.getData(new TextWriter()))
    const loadBlob = load((entry, type) => entry.getData(new BlobWriter(type)))
    const getSize = name => map.get(name)?.uncompressedSize ?? 0
    return { entries, loadText, loadBlob, getSize }
}

// 递归获取目录中的所有文件条目
const getFileEntries = async entry => entry.isFile ? entry
    : (await Promise.all(Array.from(
        await new Promise((resolve, reject) => entry.createReader()
            .readEntries(entries => resolve(entries), error => reject(error))),
        getFileEntries))).flat()

// 创建目录加载器，用于处理文件系统目录的读取
const makeDirectoryLoader = async entry => {
    const entries = await getFileEntries(entry)
    const files = await Promise.all(
        entries.map(entry => new Promise((resolve, reject) =>
            entry.file(file => resolve([file, entry.fullPath]),
                error => reject(error)))))
    const map = new Map(files.map(([file, path]) =>
        [path.replace(entry.fullPath + '/', ''), file]))
    const decoder = new TextDecoder()
    const decode = x => x ? decoder.decode(x) : null
    const getBuffer = name => map.get(name)?.arrayBuffer() ?? null
    const loadText = async name => decode(await getBuffer(name))
    const loadBlob = name => map.get(name)
    const getSize = name => map.get(name)?.size ?? 0
    return { loadText, loadBlob, getSize }
}

// 自定义错误类型定义
export class ResponseError extends Error { }
export class NotFoundError extends Error { }
export class UnsupportedTypeError extends Error { }

// 从URL获取文件
const fetchFile = async url => {
    const res = await fetch(url)
    if (!res.ok) throw new ResponseError(
        `${res.status} ${res.statusText}`, { cause: res })
    return new File([await res.blob()], new URL(res.url).pathname)
}

// 根据文件类型创建相应的电子书对象
export const makeBook = async file => {
    if (typeof file === 'string') file = await fetchFile(file)
    let book
    if (file.isDirectory) {
        const loader = await makeDirectoryLoader(file)
        const { EPUB } = await import('./epub.js')
        book = await new EPUB(loader).init()
    }
    else if (!file.size) throw new NotFoundError('文件未找到')
    else if (await isZip(file)) {
        const loader = await makeZipLoader(file)
        if (isCBZ(file)) {
            const { makeComicBook } = await import('./comic-book.js')
            book = makeComicBook(loader, file)
        }
        else if (isFBZ(file)) {
            const { makeFB2 } = await import('./fb2.js')
            const { entries } = loader
            const entry = entries.find(entry => entry.filename.endsWith('.fb2'))
            const blob = await loader.loadBlob((entry ?? entries[0]).filename)
            book = await makeFB2(blob)
        }
        else {
            const { EPUB } = await import('./epub.js')
            book = await new EPUB(loader).init()
        }
    }
    else if (await isPDF(file)) {
        const { makePDF } = await import('./pdf.js')
        book = await makePDF(file)
    }
    else {
        const { isMOBI, MOBI } = await import('./mobi.js')
        if (await isMOBI(file)) {
            const fflate = await import('./vendor/fflate.js')
            book = await new MOBI({ unzlib: fflate.unzlibSync }).open(file)
        }
        else if (isFB2(file)) {
            const { makeFB2 } = await import('./fb2.js')
            book = await makeFB2(file)
        }
    }
    if (!book) throw new UnsupportedTypeError('不支持的文件类型')
    return book
}

// 光标自动隐藏类：处理阅读界面中光标的自动显示和隐藏
class CursorAutohider {
    #timeout
    #el
    #check
    #state
    constructor(el, check, state = {}) {
        this.#el = el
        this.#check = check
        this.#state = state
        if (this.#state.hidden) this.hide()
        this.#el.addEventListener('mousemove', ({ screenX, screenY }) => {
            // 检查鼠标是否真的移动了
            if (screenX === this.#state.x && screenY === this.#state.y) return
            this.#state.x = screenX, this.#state.y = screenY
            this.show()
            if (this.#timeout) clearTimeout(this.#timeout)
            if (check()) this.#timeout = setTimeout(this.hide.bind(this), 1000)
        }, false)
    }
    // 为新元素创建光标自动隐藏实例
    cloneFor(el) {
        return new CursorAutohider(el, this.#check, this.#state)
    }
    // 隐藏光标
    hide() {
        this.#el.style.cursor = 'none'
        this.#state.hidden = true
    }
    // 显示光标
    show() {
        this.#el.style.removeProperty('cursor')
        this.#state.hidden = false
    }
}

// 历史记录管理类：处理阅读位置的前进后退
class History extends EventTarget {
    #arr = []
    #index = -1
    // 添加新的历史记录
    pushState(x) {
        const last = this.#arr[this.#index]
        if (last === x || last?.fraction && last.fraction === x.fraction) return
        this.#arr[++this.#index] = x
        this.#arr.length = this.#index + 1
        this.dispatchEvent(new Event('index-change'))
    }
    // 替换当前历史记录
    replaceState(x) {
        const index = this.#index
        this.#arr[index] = x
    }
    // 后退
    back() {
        const index = this.#index
        if (index <= 0) return
        const detail = { state: this.#arr[index - 1] }
        this.#index = index - 1
        this.dispatchEvent(new CustomEvent('popstate', { detail }))
        this.dispatchEvent(new Event('index-change'))
    }
    // 前进
    forward() {
        const index = this.#index
        if (index >= this.#arr.length - 1) return
        const detail = { state: this.#arr[index + 1] }
        this.#index = index + 1
        this.dispatchEvent(new CustomEvent('popstate', { detail }))
        this.dispatchEvent(new Event('index-change'))
    }
    // 检查是否可以后退
    get canGoBack() {
        return this.#index > 0
    }
    // 检查是否可以前进
    get canGoForward() {
        return this.#index < this.#arr.length - 1
    }
    // 清空历史记录
    clear() {
        this.#arr = []
        this.#index = -1
    }
}

// 获取语言相关信息：处理语言设置、方向和CJK（中日韩）文字判断
const languageInfo = lang => {
    if (!lang) return {}
    try {
        const canonical = Intl.getCanonicalLocales(lang)[0]
        const locale = new Intl.Locale(canonical)
        const isCJK = ['zh', 'ja', 'kr'].includes(locale.language)
        const direction = (locale.getTextInfo?.() ?? locale.textInfo)?.direction
        return { canonical, locale, isCJK, direction }
    } catch (e) {
        console.warn(e)
        return {}
    }
}

// 主视图类：处理电子书的显示和交互
export class View extends HTMLElement {
    // 私有属性
    #root = this.attachShadow({ mode: 'closed' })
    #sectionProgress    // 章节进度
    tocProgress       // 目录进度
    #pageProgress      // 页面进度
    #searchResults = new Map()  // 搜索结果
    #cursorAutohider = new CursorAutohider(this, () =>
        this.hasAttribute('autohide-cursor'))

    // 公共属性
    isFixedLayout = false  // 是否为固定布局
    lastLocation          // 最后阅读位置
    history = new History()  // 历史记录

    // 构造函数：初始化视图
    constructor() {
        super()
        this.history.addEventListener('popstate', ({ detail }) => {
            const resolved = this.resolveNavigation(detail.state)
            this.renderer.goTo(resolved)
        })
    }

    // 打开电子书文件并初始化阅读器
    async open(book) {
        if (typeof book === 'string'
            || typeof book.arrayBuffer === 'function'
            || book.isDirectory) book = await makeBook(book)
        this.book = book
        this.language = languageInfo(book.metadata?.language)

        // 如果图书有目录，初始化进度跟踪
        if (book.splitTOCHref && book.getTOCFragment) {
            const ids = book.sections.map(s => s.id)
            this.#sectionProgress = new SectionProgress(book.sections, 1500, 1600)
            const splitHref = book.splitTOCHref.bind(book)
            const getFragment = book.getTOCFragment.bind(book)
            this.tocProgress = new TOCProgress()
            await this.tocProgress.init({
                toc: book.toc ?? [], ids, splitHref, getFragment
            })
            this.#pageProgress = new TOCProgress()
            await this.#pageProgress.init({
                toc: book.pageList ?? [], ids, splitHref, getFragment
            })
        }

        // 根据图书布局类型设置渲染器
        this.isFixedLayout = this.book.rendition?.layout === 'pre-paginated'
        if (this.isFixedLayout) {
            await import('./fixed-layout.js')
            this.renderer = document.createElement('foliate-fxl')
        } else {
            await import('./paginator.js')
            this.renderer = document.createElement('foliate-paginator')
        }
        this.renderer.setAttribute('exportparts', 'head,foot,filter')
        this.renderer.addEventListener('load', e => this.#onLoad(e.detail))
        this.renderer.addEventListener('relocate', e => this.#onRelocate(e.detail))
        this.renderer.addEventListener('create-overlayer', e =>
            e.detail.attach(this.#createOverlayer(e.detail)))
        this.renderer.open(book)
        this.#root.append(this.renderer)

        // 设置媒体播放相关功能
        if (book.sections.some(section => section.mediaOverlay)) {
            const activeClass = book.media.activeClass
            const playbackActiveClass = book.media.playbackActiveClass
            this.mediaOverlay = book.getMediaOverlay()
            let lastActive
            this.mediaOverlay.addEventListener('highlight', e => {
                const resolved = this.resolveNavigation(e.detail.text)
                this.renderer.goTo(resolved)
                    .then(() => {
                        const { doc } = this.renderer.getContents()
                            .find(x => x.index = resolved.index)
                        const el = resolved.anchor(doc)
                        el.classList.add(activeClass)
                        if (playbackActiveClass) el.ownerDocument
                            .documentElement.classList.add(playbackActiveClass)
                        lastActive = new WeakRef(el)
                    })
            })
            this.mediaOverlay.addEventListener('unhighlight', () => {
                const el = lastActive?.deref()
                if (el) {
                    el.classList.remove(activeClass)
                    if (playbackActiveClass) el.ownerDocument
                        .documentElement.classList.remove(playbackActiveClass)
                }
            })
        }
    }

    // 关闭当前电子书并清理资源
    close() {
        this.renderer?.destroy()
        this.renderer?.remove()
        this.#sectionProgress = null
        this.tocProgress = null
        this.#pageProgress = null
        this.#searchResults = new Map()
        this.lastLocation = null
        this.history.clear()
        this.tts = null
        this.mediaOverlay = null
    }

    // 跳转到电子书正文开始位置
    goToTextStart() {
        return this.goTo(this.book.landmarks
            ?.find(m => m.type.includes('bodymatter') || m.type.includes('text'))
            ?.href ?? this.book.sections.findIndex(s => s.linear !== 'no'))
    }

    // 初始化阅读器：使用上次阅读位置或从头开始
    async init({ lastLocation, showTextStart }) {
        const resolved = lastLocation ? this.resolveNavigation(lastLocation) : null
        if (resolved) {
            await this.renderer.goTo(resolved)
            this.history.pushState(lastLocation)
        }
        else if (showTextStart) await this.goToTextStart()
        else {
            this.history.pushState(0)
            await this.next()
        }
    }

    // 发送事件到父窗口和监听器
    #emit(name, detail, cancelable) {
        console.log('emit', name, this.book, detail, cancelable)
        if (window.parent !== window) {
            window.parent.postMessage({
                type: `reader:${name}`,
                data: {
                    ...detail,
                    timestamp: Date.now()
                }
            }, '*')
        }
        return this.dispatchEvent(new CustomEvent(name, { detail, cancelable }))
    }


    // 处理位置变化事件
    async #onRelocate({ reason, range, index, fraction, size }) {
        const progress = this.#sectionProgress?.getProgress(index, fraction, size) ?? {}
        const tocItem = this.tocProgress?.getProgress(index, range)
        const toc = await this.book.getTocIndex(index)
        const tocContnet = await this.book.getTocContent(toc)
        const pageItem = this.#pageProgress?.getProgress(index, range)
        const cfi = this.getCFI(index, range)
        console.log('toc', toc?.path)
        console.log('tocContnet', tocContnet)
        this.lastLocation = { ...progress, tocItem, toc, tocContnet, pageItem, cfi, range }
        if (reason === 'snap' || reason === 'page' || reason === 'scroll')
            this.history.replaceState(cfi)
        this.#emit('relocate', this.lastLocation)
    }

    // 处理内容加载事件
    #onLoad({ doc, index }) {
        // 设置语言和文字方向
        doc.documentElement.lang ||= this.language.canonical ?? ''
        if (!this.language.isCJK)
            doc.documentElement.dir ||= this.language.direction ?? ''

        this.#handleLinks(doc, index)
        this.#cursorAutohider.cloneFor(doc.documentElement)

        this.#emit('load', { doc, index })
    }

    // 设置文档中链接的点击处理
    #handleLinks(doc, index) {
        const { book } = this
        const section = book.sections[index]
        doc.addEventListener('click', e => {
            const a = e.target.closest('a[href]')
            if (!a) return
            e.preventDefault()
            const href_ = a.getAttribute('href')
            const href = section?.resolveHref?.(href_) ?? href_
            if (book?.isExternal?.(href))
                Promise.resolve(this.#emit('external-link', { a, href }, true))
                    .then(x => x ? globalThis.open(href, '_blank') : null)
                    .catch(e => console.error(e))
            else Promise.resolve(this.#emit('link', { a, href }, true))
                .then(x => x ? this.goTo(href) : null)
                .catch(e => console.error(e))
        })
    }

    // 添加或删除注释
    async addAnnotation(annotation, remove) {
        const { value } = annotation
        if (value.startsWith(SEARCH_PREFIX)) {
            const cfi = value.replace(SEARCH_PREFIX, '')
            const { index, anchor } = await this.resolveNavigation(cfi)
            const obj = this.#getOverlayer(index)
            if (obj) {
                const { overlayer, doc } = obj
                if (remove) {
                    overlayer.remove(value)
                    return
                }
                const range = doc ? anchor(doc) : anchor
                overlayer.add(value, range, Overlayer.outline)
            }
            return
        }
        const { index, anchor } = await this.resolveNavigation(value)
        const obj = this.#getOverlayer(index)
        if (obj) {
            const { overlayer, doc } = obj
            overlayer.remove(value)
            if (!remove) {
                const range = doc ? anchor(doc) : anchor
                const draw = (func, opts) => overlayer.add(value, range, func, opts)
                this.#emit('draw-annotation', { draw, annotation, doc, range })
            }
        }
        const label = this.tocProgress.getProgress(index)?.label ?? ''
        return { index, label }
    }

    // 删除注释
    deleteAnnotation(annotation) {
        return this.addAnnotation(annotation, true)
    }

    // 获取指定章节的叠加层
    #getOverlayer(index) {
        return this.renderer.getContents()
            .find(x => x.index === index && x.overlayer)
    }

    // 创建注释和搜索结果的叠加层
    #createOverlayer({ doc, index }) {
        const overlayer = new Overlayer()
        doc.addEventListener('click', e => {
            const [value, range] = overlayer.hitTest(e)
            if (value && !value.startsWith(SEARCH_PREFIX)) {
                this.#emit('show-annotation', { value, index, range })
            }
        }, false)

        const list = this.#searchResults.get(index)
        if (list) for (const item of list) this.addAnnotation(item)

        this.#emit('create-overlay', { index })
        return overlayer
    }

    // 通过导航显示注释
    async showAnnotation(annotation) {
        const { value } = annotation
        const resolved = await this.goTo(value)
        if (resolved) {
            const { index, anchor } = resolved
            const { doc } = this.#getOverlayer(index)
            const range = anchor(doc)
            this.#emit('show-annotation', { value, index, range })
        }
    }

    // 获取位置的内容片段标识符（CFI）
    getCFI(index, range) {
        const baseCFI = this.book.sections[index].cfi ?? CFI.fake.fromIndex(index)
        if (!range) return baseCFI
        return CFI.joinIndir(baseCFI, CFI.fromRange(range))
    }

    // 解析CFI为图书中的位置
    resolveCFI(cfi) {
        if (this.book.resolveCFI)
            return this.book.resolveCFI(cfi)
        else {
            const parts = CFI.parse(cfi)
            const index = CFI.fake.toIndex((parts.parent ?? parts).shift())
            const anchor = doc => CFI.toRange(doc, parts)
            return { index, anchor }
        }
    }

    // 解析导航目标为图书中的位置
    resolveNavigation(target) {
        try {
            if (typeof target === 'number') return { index: target }
            if (typeof target.fraction === 'number') {
                const [index, anchor] = this.#sectionProgress.getSection(target.fraction)
                return { index, anchor }
            }
            if (CFI.isCFI.test(target)) return this.resolveCFI(target)
            return this.book.resolveHref(target)
        } catch (e) {
            console.error(e)
            console.error(`无法解析目标 ${target}`)
        }
    }

    // 导航到图书中的目标位置
    async goTo(target) {
        const resolved = this.resolveNavigation(target)
        try {
            await this.renderer.goTo(resolved)
            this.history.pushState(target)
            return resolved
        } catch (e) {
            console.error(e)
            console.error(`无法跳转到 ${target}`)
        }
    }

    // 导航到图书的特定比例位置
    async goToFraction(frac) {
        const [index, anchor] = this.#sectionProgress.getSection(frac)
        await this.renderer.goTo({ index, anchor })
        this.history.pushState({ fraction: frac })
    }

    // 在目标位置选择文本
    async select(target) {
        try {
            const obj = await this.resolveNavigation(target)
            await this.renderer.goTo({ ...obj, select: true })
            this.history.pushState(target)
        } catch (e) {
            console.error(e)
            console.error(`无法跳转到 ${target}`)
        }
    }

    // 取消文本选择
    deselect() {
        for (const { doc } of this.renderer.getContents())
            doc.defaultView.getSelection().removeAllRanges()
    }

    // 获取每个章节的比例位置
    getSectionFractions() {
        return (this.#sectionProgress?.sectionFractions ?? [])
            .map(x => x + Number.EPSILON)
    }

    // 获取特定位置的进度信息
    getProgressOf(index, range) {
        const tocItem = this.tocProgress?.getProgress(index, range)
        const pageItem = this.#pageProgress?.getProgress(index, range)
        return { tocItem, pageItem }
    }

    // 获取特定目标的目录项
    async getTOCItemOf(target) {
        try {
            const { index, anchor } = await this.resolveNavigation(target)
            const doc = await this.book.sections[index].createDocument()
            const frag = anchor(doc)
            const isRange = frag instanceof Range
            const range = isRange ? frag : doc.createRange()
            if (!isRange) range.selectNodeContents(frag)
            return this.tocProgress.getProgress(index, range)
        } catch (e) {
            console.error(e)
            console.error(`无法获取 ${target}`)
        }
    }

    // 导航到上一页/章节
    async prev(distance) {
        await this.renderer.prev(distance)
    }

    // 导航到下一页/章节
    async next(distance) {
        await this.renderer.next(distance)
    }

    // 向左导航（考虑RTL方向）
    goLeft() {
        return this.book.dir === 'rtl' ? this.next() : this.prev()
    }

    // 向右导航（考虑RTL方向）
    goRight() {
        return this.book.dir === 'rtl' ? this.prev() : this.next()
    }

    // 导航到下一章节
    nextChapter() {
        return this.renderer.nextChapter()
    }

    // 导航到上一章节
    prevChapter() {
        return this.renderer.prevChapter()
    }

    // 在章节内搜索的生成器函数
    async * #searchSection(matcher, query, index) {
        const doc = await this.book.sections[index].createDocument()
        for (const { range, excerpt } of matcher(doc, query))
            yield { cfi: this.getCFI(index, range), excerpt }
    }

    // 在整本书中搜索的生成器函数
    async * #searchBook(matcher, query) {
        const { sections } = this.book
        for (const [index, { createDocument }] of sections.entries()) {
            if (!createDocument) continue
            const doc = await createDocument()
            const subitems = Array.from(matcher(doc, query), ({ range, excerpt }) =>
                ({ cfi: this.getCFI(index, range), excerpt }))
            const progress = (index + 1) / sections.length
            yield { progress }
            if (subitems.length) yield { index, subitems }
        }
    }

    // 在图书中执行搜索
    async * search(opts) {
        this.clearSearch()
        const { searchMatcher } = await import('./search.js')
        const { query, index } = opts
        const matcher = searchMatcher(textWalker,
            { defaultLocale: this.language, ...opts })
        const iter = index != null
            ? this.#searchSection(matcher, query, index)
            : this.#searchBook(matcher, query)

        const list = []
        this.#searchResults.set(index, list)

        for await (const result of iter) {
            if (result.subitems) {
                const list = result.subitems
                    .map(({ cfi }) => ({ value: SEARCH_PREFIX + cfi }))
                this.#searchResults.set(result.index, list)
                for (const item of list) this.addAnnotation(item)
                yield {
                    label: this.tocProgress.getProgress(result.index)?.label ?? '',
                    subitems: result.subitems,
                }
            }
            else {
                if (result.cfi) {
                    const item = { value: SEARCH_PREFIX + result.cfi }
                    list.push(item)
                    this.addAnnotation(item)
                }
                yield result
            }
        }
        yield 'done'
    }

    // 清除所有搜索结果
    clearSearch() {
        for (const list of this.#searchResults.values())
            for (const item of list) this.deleteAnnotation(item)
        this.#searchResults.clear()
    }

    // 初始化文本转语音功能
    async initTTS() {
        const doc = this.renderer.getContents()[0].doc
        if (this.tts && this.tts.doc === doc) return
        const { TTS } = await import('./tts.js')
        this.tts = new TTS(doc, textWalker, range =>
            this.renderer.scrollToAnchor(range, true))
    }

    // 开始媒体叠加播放
    startMediaOverlay() {
        const { index } = this.renderer.getContents()[0]
        return this.mediaOverlay.start(index)
    }
}

// 注册自定义元素
customElements.define('foliate-view', View)
