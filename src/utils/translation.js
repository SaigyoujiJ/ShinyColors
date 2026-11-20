import { getNounFix, getCaiyunPrefix } from '../store/text-fix'
import { replaceWords, log, log2, replaceQuote, fixWrap, replaceWrap, storyTextLogStyle, tagStoryText, sess } from '../utils/index'
import { fetchInfo } from './fetch'
import { getCommStory } from '../store/story'
import getTypeTextMap from '../store/typeText'
import config from '../config'
import caiyunApi from './caiyun'
import showAiTransHint from '../utils/aiTransHint'
import { readConfig, callLLM } from './myLLM'
import retryOnce from './retry'

const joinBr = (list, br, transArr) => {
  br.forEach(count => {
    let i = count
    let str = ''
    while (i >= 0) {
      i--
      let _str = list.shift()
      if (typeof _str === 'string') {
        if (!_str) {
          _str = '……'
        }
        str += _str + '\n'
      }
    }
    if (str) {
      transArr.push(str.slice(0, str.length - 1))
    }
  })
}

const joinText = (list) => {
  let br = []
  let _list = list.map(text => fixWrap(text))
  _list.forEach((text) => {
    let count = [...text].filter(l => l === '\n').length
    br.push(count)
  })
  let query = _list.join('\n')
  return [query, br]
}

const splitText = (text, WORDS_LIMIT = 4000) => {
  let strTemp = ''
  let arr = []
  let count = 0
  text.split('\n').forEach(txt => {
    strTemp += txt
    count += new Blob([txt]).size
    if (count > WORDS_LIMIT) {
      arr.push(strTemp)
      count = 0
      strTemp = ''
    } else {
      strTemp += '\n'
    }
  })
  if (strTemp) {
    arr.push(strTemp.replace(/\n$/, ''))
  }
  return arr
}

const caiyunTrans = async (source) => {
  try {
    let limitTime = sess('caiyuLimit')
    if (limitTime && Date.now() - limitTime < 1000 * 60 * 60) {
      return []
    }
    let [query, br] = joinText(source)
    let textArr = splitText(query)
    let result = await Promise.all(textArr.map(query => {
      return caiyunApi(query.split('\n'))
    }))
    let list = result.reduce((a, b) => a.concat(b))
    let transArr = []
    joinBr(list, br, transArr)
    return transArr
  } catch (e) {
    if (e.message === 'Caiyun api out of limit.') {
      sess('caiyuLimit', Date.now())
    }
    log(e)
    return []
  }
}

/**
 * 自有 LLM 兜底层：与 caiyunTrans 共用同一套合并/切分/换行重组管线，
 * 保证译文条数与原文逐句对齐。任何一批返回空或格式不符，整段放弃兜底。
 */
const llmTrans = async (source) => {
  try {
    const [query, br] = joinText(source)
    const textArr = splitText(query)
    const results = await Promise.all(textArr.map(part => callLLM(part.split('\n'))))
    if (!results.length || results.some(list => !list.length)) return []
    const list = results.reduce((a, b) => a.concat(b), [])
    const transArr = []
    joinBr(list, br, transArr)
    return transArr
  } catch (e) {
    log(e)
    return []
  }
}

const textKeys = [
  'text', 'select', 'comment', 'title',
  'actionComment', 'actionComment2', 'reactionComment',
  'resultLoseComment', 'resultStartComment', 'resultWinComment',
  'characterComment', 'producerComment', 'comment1', 'comment2',
  'mainText', 'resultText', 'name'
]
const collectText = (data, commMap, typeTextMap) => {
  const textInfo = []
  const textList = []
  data.forEach((item, index) => {
    textKeys.forEach(key => {
      let text = fixWrap(item[key])
      if (item[key]) {
        if (commMap.has(text)) {
          item[key] = commMap.get(text)
        } else if (typeTextMap.has(text)) {
          item[key] = typeTextMap.get(text)
        } else {
          textInfo.push({ key, index })
          textList.push(text)
        }
      }
    })
  })
  return { textInfo, textList }
}

const preFix = async (list) => {
  const cyfMap = await getCaiyunPrefix()
  return replaceWords(list, cyfMap)
}

const nounFix = async (list) => {
  const nounFixMap = await getNounFix()
  return replaceWords(list, nounFixMap)
}

const autoWrap = (text, count) => {
  if (text.length > count && !text.includes('\n')) {
    const len = Math.floor(text.length / 2) + 1
    return text.slice(0, len) + '\n' + text.slice(len, text.length)
  }
  return text
}

const autoTransCache = new Map()

const autoTrans = async (data, name, printText, skip = false) => {
  if (!data.length) return
  const commMap = await getCommStory()
  const typeTextMap = await getTypeTextMap()
  const { textInfo, textList } = collectText(data, commMap, typeTextMap)
  if (!textInfo.length) return

  const storyKey = name || data
  const cached = autoTransCache.get(storyKey)
  const hasCache = !!cached
  let fixedTransList = []
  let transHint = ''
  let transStatus = 'ok'

  if (hasCache) {
    fixedTransList = cached.list
    transHint = cached.hint
    transStatus = cached.status
  } else {
    const transApi = fetchInfo.data.trans_api
    let transList = []

    if (config.auto === 'on' && !skip) {
      // 译文必须逐句对齐且每条非空，否则视为该层失败
      const isFull = (list) =>
        Array.isArray(list) &&
        list.length === textList.length &&
        list.every(t => t && String(t).trim())

      if (transApi === 'caiyun') {
        const fixedTextList = await preFix(textList)
        const llm = readConfig()

        if (llm.enabled && llm.skipCaiyun) {
          // 第三层直接换成自有大模型（跳过彩云）；失败重试 1 次
          transList = await retryOnce(
            () => llmTrans(fixedTextList), isFull, '自有大模型'
          )
          if (isFull(transList)) {
            transHint = '这段剧情由自有大模型机翻'
          } else {
            transList = []
            transHint = '机翻失败：自有大模型未返回译文（已重试 1 次）'
            transStatus = 'error'
          }
        } else {
          // 第三层仍是彩云；失败重试 1 次，仍失败才落到第四层自有大模型
          transList = await retryOnce(
            () => caiyunTrans(fixedTextList), isFull, '彩云小译'
          )
          if (isFull(transList)) {
            transHint = '这段剧情由彩云小译机翻'
          } else {
            transList = []
            if (llm.enabled) {
              const fallback = await retryOnce(
                () => llmTrans(fixedTextList), isFull, '自有大模型（兜底）'
              )
              if (isFull(fallback)) {
                transList = fallback
                transHint = '这段剧情由自有大模型机翻（彩云小译失败）'
              } else {
                transHint = '机翻失败：彩云小译与自有大模型均未返回译文（已各重试 1 次）'
                transStatus = 'error'
              }
            } else {
              transHint = '机翻失败：彩云小译未返回译文（已重试 1 次）'
              transStatus = 'error'
            }
          }
        }
      } else {
        transHint = '机翻失败：未配置可用的翻译通道'
        transStatus = 'error'
      }
      if (!Array.isArray(transList)) transList = []
      fixedTransList = await nounFix(transList)
    }

    // 失败结果不入缓存：下次进入该剧情仍会重新尝试，避免一次抖动锁死整段
    if (transStatus === 'ok' && fixedTransList.length) {
      autoTransCache.set(storyKey, { list: fixedTransList, hint: transHint, status: transStatus })
    }
  }
  if (!hasCache && (config.dev || !name || printText)) {
    let mergedList = []
    textList.forEach((text, index) => {
      mergedList.push([replaceWrap(text), replaceWrap(fixedTransList[index])])
    })
    let _log = log
    if (!name || printText) _log = log2
    const text = storyTextLogStyle(mergedList)
    _log(text)
  }

  // 只要确实尝试过机翻就提示：成功显示来源，失败显示原因（红色）
  if (!printText && config.auto === 'on' && !skip) {
    showAiTransHint(transHint || '这段剧情由机翻生成', transStatus)
  }

  fixedTransList.forEach((trans, idx) => {
    let _trans = trans
    const { key, index } = textInfo[idx]

    if (key === 'select') {
      _trans = autoWrap(_trans, 8)
    }
    _trans = replaceQuote(_trans)
    data[index][key] = _trans
  })

  tagStoryText(data)
}

export default autoTrans
