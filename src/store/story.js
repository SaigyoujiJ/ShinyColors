import fetchData from '../utils/fetch'
import parseCsv from '../utils/parseCsv'
import { getList, getLocalData, setLocalData } from './index'
import { trimWrap, trim, uniqueStoryId } from '../utils/index'
import config from '../config'
import retryOnce from '../utils/retry'

const storyTemp = new Map()
const aiStoryTemp = new Map()
const commStoryMap = new Map()
let commStoryLoaded = false
let storyIndex = null
let aiStoryIndex = null

const getStoryMap = (csv, isAI) => {
  const list = parseCsv(csv)
  const storyMap = new Map()
  const getId = uniqueStoryId()

  const translator = list.find(item => {
    return item.id === '译者'
  }).name || ''
  list.forEach(item => {
    const id = getId(trim(item.id))
    const text = trimWrap(item.text)
    let trans = trimWrap(item.trans, true)
    const name = trim(item.name)
    if (text && trans) {
      if (id && !/^0+$/.test(id) && id !== 'select') {
        storyMap.set(id, trans)
      } else {
        if (id === 'select') {
          storyMap.set(`${text}-select`, trans)
        } else {
          storyMap.set(text, trans)
        }
      }
    }
    if (id && name && id === 'info') {
      storyMap.set('name', name)
    }
  })
  if (isAI) {
    storyMap.set('isAI', `这段剧情由 ${translator}(LLM) 机翻`)
  }
  return storyMap
}

const isCsv = (v) => typeof v === 'string' && v.trim().length > 0

const parseStoryMap = (csv, isAI) => {
  try {
    return getStoryMap(csv, isAI)
  } catch (e) {
    // CSV 结构异常（例如缺少「译者」行）不再让整段剧情翻译中断
    console.warn('[sczh] 剧情 CSV 解析失败，降级到下一层', e)
    return false
  }
}

const getStory = async (name) => {
  if (!storyIndex) {
    const storyIndexStr = await getLocalData('story.json')
    if (!storyIndexStr) {
      const storyIndexData = await retryOnce(
        () => fetchData('/story.json'), Array.isArray, '人工译文索引 story.json'
      )
      const ok = Array.isArray(storyIndexData)
      storyIndex = new Map(ok ? storyIndexData : [])
      // JSON.stringify(Map) 会得到 '{}'，必须转成数组才能被缓存正确还原
      if (ok) setLocalData('story.json', JSON.stringify([...storyIndex]))
    } else {
      try {
        storyIndex = new Map(JSON.parse(storyIndexStr))
      } catch (e) {
        storyIndex = new Map()
      }
    }
  }
  if (storyIndex.has(name)) {
    if (storyTemp.has(name)) {
      return storyTemp.get(name)
    } else {
      const fileName = storyIndex.get(name)
      const csvStr = await retryOnce(
        () => fetchData(`/data/story/${fileName}.csv`), isCsv, `人工译文 ${fileName}.csv`
      )
      if (!isCsv(csvStr)) return false
      const storyMap = parseStoryMap(csvStr, false)
      if (!storyMap) return false
      storyTemp.set(name, storyMap)
      return storyMap
    }
  }

  return false
}

const getAIStory = async (name) => {
  if (!aiStoryIndex) {
    const aiStoryIndexStr = await getLocalData('story-ai.json')
    if (!aiStoryIndexStr) {
      const aiStoryIndexData = await retryOnce(
        () => fetchData(`${config.ai_host}/story.json`), Array.isArray, 'LLM 译文索引 story.json'
      )
      const ok = Array.isArray(aiStoryIndexData)
      // 两次都失败时置为空索引：本页不再重复请求，但返回 false 让上层降级到实时机翻
      aiStoryIndex = new Map(ok ? aiStoryIndexData : [])
      if (ok) setLocalData('story-ai.json', JSON.stringify([...aiStoryIndex]))
    } else {
      try {
        aiStoryIndex = new Map(JSON.parse(aiStoryIndexStr))
      } catch (e) {
        aiStoryIndex = new Map()
      }
    }
  }
  if (aiStoryIndex.has(name)) {
    if (aiStoryTemp.has(name)) {
      return aiStoryTemp.get(name)
    } else {
      const fileName = aiStoryIndex.get(name)
      const csvStr = await retryOnce(
        () => fetchData(`${config.ai_host}/story/${fileName}.csv`), isCsv, `LLM 译文 ${fileName}.csv`
      )
      if (!isCsv(csvStr)) return false
      const storyMap = parseStoryMap(csvStr, true)
      if (!storyMap) return false
      aiStoryTemp.set(name, storyMap)
      return storyMap
    }
  }

  return false
}

const getCommStory = async () => {
  if (!commStoryLoaded) {
    try {
      const list = await getList('comm-story')
      list.forEach(item => {
        if (item?.text) {
          const text = trimWrap(item.text)
          const trans = trimWrap(item.trans, true)
          if (text && trans && text !== trans) {
            commStoryMap.set(text, trans)
          }
        }
      })
    } catch (e) {
      // 通用剧情表加载失败不应阻断后续所有翻译层
      console.warn('[sczh] 通用剧情表加载失败，继续降级', e)
    }
    commStoryLoaded = true
  }

  return commStoryMap
}

export { getStoryMap, getCommStory, getAIStory }
export default getStory
