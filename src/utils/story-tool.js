import debounce from 'lodash/debounce'
import config, { saveConfig, PREVIEW_COUNT } from '../config'
import { tryDownload } from './index'
import CSV from 'papaparse/papaparse.min'
import { getStoryMap } from '../store/story'

const html = `
  <style>
  #sczh-story-tool {
    position: fixed;
    display: none;
    background: #ffffff;
    border-radius: 24px;
    box-sizing: border-box;
    font-family: HummingStd-E;
    align-items: center;
    justify-content: center;
    color: #ff6499;
    text-shadow: 0 0 6px #fff;
    cursor: grab;
    user-select: none;
    touch-action: none;
    width: 100px;
    height: 100px;
    font-size: 32px;
    border: 7px solid transparent;
    border-image: url(${config.origin}/data/image/border.png);
    border-image-slice: 7;
    transform-origin: top left;
    transition: opacity 0.3s, width 0.18s ease, left 0.18s ease, top 0.18s ease;
  }
  #sczh-story-tool.dragging {
    cursor: grabbing;
    transition: opacity 0.3s;
  }
  #sczh-story-tool.expanded {
    width: 200px;
  }
  .story-tool-btns {
    width: 100%;
    height: 100%;
    display: none;
  }
  .story-tool-btns .btn-download-sczh,
  .story-tool-btns label {
    flex: 1;
    height: 100%;
    background: #fff;
    display: flex;
    box-sizing: content-box;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    color: #c0aade;
    text-shadow: 0 0 6px #fff;
  }
  .story-tool-btns .btn-download-sczh:hover {
    color: #9f66ec;
  }
  .story-tool-btns label {
    color: rgb(242, 156, 199);
    border-right: 1px solid #c9c9c9;
  }
  #sczh-story-tool .btn-close-sczh {
    height: 25px;
    width: 50px;
    background: rgba(0, 0, 0, 0.58);
    color: #fff;
    letter-spacing: 2px;
    position: absolute;
    right: -25px;
    top: -20px;
    border-radius: 4px;
    display: none;
    align-items: center;
    justify-content: center;
    z-index: 1;
    font-family: UDKakugo_SmallPr6-B;
    font-size: 15px;
    cursor: pointer;
  }
  #sczh-story-tool.expanded .story-tool-btns,
  #sczh-story-tool.expanded .btn-close-sczh {
    display: flex;
  }
  #sczh-story-tool.expanded > .text-sczh {
    display: none;
  }
  #sczh-story-tool .btn-close-sczh:hover {
    background: rgba(0, 0, 0, 0.9);
  }
  #sczh-story-tool.blur {
    opacity: 0.2;
  }
  .story-tool-btns label:hover {
    color: #f270b1;
  }
  .story-tool-btns .btn-download-sczh:hover,
  .story-tool-btns label:hover {
    background-color: #f7f7f7;
  }
  </style>
  <div id="sczh-story-tool"><span class="text-sczh">剧情</span>
    <span id="btn-close-sczh" class="btn-close-sczh">关闭</span>
    <input type="file" style="display:none" id="ipt-preview-sczh" multiple accept=".csv">
    <div class="story-tool-btns">
      <label for="ipt-preview-sczh">预览</label>
      <div id="btn-download-sczh" class="btn-download-sczh">下载</div>
    </div>
  </div>
  `
const savePreview = (map) => {
  const arr = [...map].slice(-PREVIEW_COUNT)
  const newArr = arr.map(item => {
    item[1] = [...item[1]]
    return item
  })
  sessionStorage.setItem('sczh:preview', JSON.stringify(newArr))
}

// 主体尺寸为未经 scale 的 CSS 像素。展开时宽度翻倍；关闭按钮在展开态
// 溢出主体右上角，边界计算必须把这两处外溢量一并计入，否则贴边时会被裁切。
const BTN_W = 100
const BTN_H = 100
const EXPANDED_W = 200
const CLOSE_OVERFLOW_X = 25
const CLOSE_OVERFLOW_Y = 20
const EDGE_GAP = 8
const DRAG_THRESHOLD = 5
const CONTROL_SELECTOR = '#btn-download-sczh, #btn-close-sczh, #ipt-preview-sczh, .story-tool-btns label'

let showToolFlag = false
const showStoryTool = (storyCache) => {
  if (showToolFlag) return
  showToolFlag = true
  document.body.insertAdjacentHTML('beforeend', html)
  const cont = document.getElementById('sczh-story-tool')

  let scale = 1
  let expanded = false
  let pinned = false          // 点击固定展开
  let hovered = false         // 悬停临时展开，保留原有体验
  let hoverLocked = false     // 点击收起后抑制 hover，直到指针移出再移入
  let pointerInside = false
  let dragging = false
  let suppressClick = false
  let userMoved = false
  let dragState = null
  let blurTimer

  // 用户定位坐标：只在初始定位、拖动、resize 时改变。
  // 展开时为防溢出产生的偏移是临时的，收起后按 userPos 恢复，不写回定位坐标。
  const userPos = { left: 0, top: 0, ready: false }
  // 实际显示坐标（可能被展开态边界钳制），拖动以此为起点保证视觉连续
  const viewPos = { left: 0, top: 0 }

  const num = (value) => {
    const n = parseFloat(value)
    return Number.isFinite(n) ? n : 0
  }

  /**
   * 可移动区域边界：默认取视口；若页面存在 #sczh-story-boundary 容器则改用其可视矩形。
   * left/top 为视口坐标，与 position: fixed 的 left/top 同一坐标系。
   */
  const getBoundary = () => {
    const container = document.getElementById('sczh-story-boundary')
    if (container && typeof container.getBoundingClientRect === 'function') {
      const rect = container.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      }
    }
    return {
      left: 0,
      top: 0,
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight
    }
  }

  /**
   * 依据当前展开状态，把用户定位坐标映射为实际显示坐标。
   * 边界钳制只作用于显示坐标，不改写 userPos：展开时为容纳 200px 宽度
   * 与关闭按钮外溢产生的左移是临时的，收起后会自动回到用户定位位置。
   */
  const clampPosition = () => {
    if (!userPos.ready) return
    const box = getBoundary()
    const s = scale
    const w = (expanded ? EXPANDED_W : BTN_W) * s
    const h = BTN_H * s
    const overflowRight = expanded ? CLOSE_OVERFLOW_X * s : 0
    const overflowTop = expanded ? CLOSE_OVERFLOW_Y * s : 0
    const minL = box.left + EDGE_GAP
    const maxL = Math.max(minL, box.left + box.width - w - overflowRight - EDGE_GAP)
    const minT = box.top + EDGE_GAP + overflowTop
    const maxT = Math.max(minT, box.top + box.height - h - EDGE_GAP)
    viewPos.left = Math.round(Math.min(Math.max(userPos.left, minL), maxL))
    viewPos.top = Math.round(Math.min(Math.max(userPos.top, minT), maxT))
    cont.style.left = `${viewPos.left}px`
    cont.style.top = `${viewPos.top}px`
  }

  /** 展开状态统一由 JS 计算；拖动过程中强制收起，避免宽度突变与误触 */
  const syncExpanded = () => {
    expanded = !!(!dragging && !hoverLocked && (pinned || hovered))
    cont.classList.toggle('expanded', expanded)
    clampPosition()
  }

  const setToolPos = debounce(() => {
    const pos = [0.017, 0.22]
    const size = [0.058, 0.058]
    const height = window.innerHeight
    const width = window.innerWidth
    const h_w = height / width
    let ch = height
    let cw = width
    let offsetTop = 0
    let offsetRight = 0
    if (h_w > 9 / 16) {
      ch = width * 9 / 16
      offsetTop = (height - ch) / 2
    } else {
      cw = height * 16 / 9
      offsetRight = (width - cw) / 2
    }
    scale = ch / 900
    cont.style.transform = `scale(${scale.toFixed(3)})`
    // 与旧实现的视觉位置一致：右边缘对齐 16:9 画面右侧内缩 1.7%；
    // 改用 left/top + transform-origin: top left，便于拖动与边界计算。
    // 用户拖动过之后，窗口变化只更新缩放并重新约束，不覆盖自定义位置。
    if (!userMoved) {
      const rightEdge = width - offsetRight - pos[0] * cw
      userPos.left = Math.floor(rightEdge - BTN_W * scale)
      userPos.top = Math.floor(offsetTop + pos[1] * ch)
      userPos.ready = true
    }
    clampPosition()
    // cont.style.width = Math.floor(size[0] * cw) + 'px'
    // cont.style.height = Math.floor(size[1] * cw) + 'px'
    // cont.style.fontSize = Math.floor(size[1] * cw * 0.35) + 'px'
    if (storyCache.name) {
      cont.style.display = 'flex'
    } else {
      cont.style.display = 'none'
    }
  }, 300)

  setToolPos()

  window.addEventListener('resize', setToolPos)

  const contBlur = () => {
    clearTimeout(blurTimer)
    blurTimer = setTimeout(() => {
      cont.classList.add('blur')
    }, 5000)
  }

  cont.addEventListener('mouseenter', () => {
    pointerInside = true
    clearTimeout(blurTimer)
    cont.classList.remove('blur')
    hovered = true
    syncExpanded()
  })

  cont.addEventListener('mouseleave', () => {
    pointerInside = false
    hovered = false
    hoverLocked = false
    syncExpanded()
    if (!dragging) contBlur()
  })
  contBlur()

  /* ---------- 拖动：指针事件统一鼠标与触摸，超过阈值才判定为拖动 ---------- */
  const onPointerDown = (e) => {
    if (e.button !== undefined && e.button !== 0) return
    dragState = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      left: num(cont.style.left),
      top: num(cont.style.top)
    }
  }

  const onPointerMove = (e) => {
    if (!dragState) return
    if (dragState.pointerId !== undefined && e.pointerId !== undefined &&
        e.pointerId !== dragState.pointerId) return
    const dx = e.clientX - dragState.startX
    const dy = e.clientY - dragState.startY
    if (!dragging) {
      if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return
      const wasExpanded = expanded
      dragging = true
      hovered = false
      hoverLocked = false
      const baseLeft = userPos.ready ? viewPos.left : dragState.left
      const baseTop = userPos.ready ? viewPos.top : dragState.top
      // 展开态下按钮宽度翻倍，且贴近右边界时会被向左推移，指针往往落在右半边
      // （或右上角外溢关闭按钮上）。开始拖动并收起为 100px 时，按相对比例重映射
      // 抓点坐标，避免左对齐收缩导致按钮脱离指针向左漂移。
      if (wasExpanded) {
        const expandedW = EXPANDED_W * scale
        const collapsedW = BTN_W * scale
        const collapsedH = BTN_H * scale
        const ratioX = expandedW > 0
          ? Math.min(Math.max((dragState.startX - baseLeft) / expandedW, 0), 1)
          : 0.5
        const offsetY = Math.min(Math.max(dragState.startY - baseTop, 0), collapsedH)
        dragState.left = dragState.startX - ratioX * collapsedW
        dragState.top = dragState.startY - offsetY
      } else {
        dragState.left = baseLeft
        dragState.top = baseTop
      }
      userPos.left = dragState.left
      userPos.top = dragState.top
      cont.classList.add('dragging')
      syncExpanded()
      // 仅在确认为拖动后才捕获指针：既不受游戏页面阻止冒泡的影响，
      // 也不会改变普通点击的 target（否则预览/下载/关闭会失效）
      if (cont.setPointerCapture && e.pointerId !== undefined) {
        try { cont.setPointerCapture(e.pointerId) } catch (err) {}
      }
    }
    if (e.cancelable && e.preventDefault) e.preventDefault()
    userMoved = true
    userPos.left = dragState.left + dx
    userPos.top = dragState.top + dy
    clampPosition()
  }

  const onPointerUp = (e) => {
    if (!dragState) return
    if (e && dragState.pointerId !== undefined && e.pointerId !== undefined &&
        e.pointerId !== dragState.pointerId) return
    if (cont.releasePointerCapture && dragState.pointerId !== undefined) {
      // 未真正捕获过时浏览器会抛错，忽略即可
      try { cont.releasePointerCapture(dragState.pointerId) } catch (err) {}
    }
    if (dragging) {
      // 拖动结束后浏览器仍可能派发一次 click，吞掉它，
      // 避免误触「预览 / 下载 / 关闭」或误切换展开状态
      suppressClick = true
      setTimeout(() => { suppressClick = false }, 250)
    }
    dragging = false
    dragState = null
    cont.classList.remove('dragging')
    syncExpanded()
    if (!pointerInside) contBlur()
  }

  // 不在 pointerdown 时 setPointerCapture：捕获会改变紧随其后 click 的 target，
  // 使「预览 / 下载 / 关闭」的点击失效。改为在 window 上监听 move/up。
  cont.addEventListener('pointerdown', onPointerDown)
  window.addEventListener('pointermove', onPointerMove, { passive: false })
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', onPointerUp)

  const isControl = (target) => !!(target && typeof target.closest === 'function' &&
    target.closest(CONTROL_SELECTOR))

  // 捕获阶段拦截拖动产生的 click；冒泡阶段处理「点击展开 / 收起」
  cont.addEventListener('click', (e) => {
    if (!suppressClick) return
    suppressClick = false
    if (e.preventDefault) e.preventDefault()
    if (e.stopPropagation) e.stopPropagation()
  }, true)

  cont.addEventListener('click', (e) => {
    if (isControl(e.target)) return
    if (pinned) {
      pinned = false
      hoverLocked = true
    } else {
      pinned = true
      hoverLocked = false
    }
    syncExpanded()
  })

  const btnDl = document.getElementById('btn-download-sczh')

  btnDl.addEventListener('click', function () {
    if (storyCache.name) {
      const str = CSV.unparse(storyCache.list)
      tryDownload(str, storyCache.filename)
    }
  })

  const btnClose = document.getElementById('btn-close-sczh')
  btnClose.addEventListener('click', function () {
    cont.style.display = 'none'
    config.story = 'normal'
    saveConfig()
  })

  const iptPreview = document.getElementById('ipt-preview-sczh')
  iptPreview.addEventListener('change', function () {
    const files = [...this.files]
    if (!files.length) return
    files.forEach(file => {
      const reader = new FileReader()
      reader.onload = e => {
        const text = e.target.result
        const storyMap = getStoryMap(text)
        if (storyMap.has('name')) {
          const _name = storyMap.get('name')
          storyCache.preview.set(_name, storyMap)
          savePreview(storyCache.preview)
          alert(`导入${_name}成功`)
        }
      }
      reader.readAsText(file)
    })
  })
}

export default showStoryTool
