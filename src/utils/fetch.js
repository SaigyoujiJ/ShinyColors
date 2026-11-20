import config from '../config'
import { isNewVersion } from './index'
import retryOnce from './retry'

const { origin, version } = config

const saveManifest = async () => {
  const t = Math.floor(Date.now() / 1000 / 60 / 60 / 6)
  const data = await retryOnce(async () => {
    const res = await fetch(`${origin}/manifest.json?t=${t}`)
    if (!res.ok) throw new Error(`${res.status} ${res.url}`)
    return res.json()
  }, d => d && d.version, 'manifest.json')
  if (!data || !data.version) throw new Error('manifest.json 加载失败（已重试 1 次）')
  data.time = Date.now()
  localStorage.setItem('sczh:manifest', JSON.stringify(data))
  return data
}

const getManifest = async () => {
  let data
  try {
    let str = localStorage.getItem('sczh:manifest')
    if (str) data = JSON.parse(str)
    if (Date.now() - data.time > config.cacheTime * 60 * 1000) data = false
  } catch (e) {}
  if (!data) {
    data = await saveManifest()
  } else {
    if (isNewVersion(version, data.version)) {
      data = await saveManifest()
    } else {
      setTimeout(() => saveManifest().catch(() => {}), 5 * 1000)
    }
  }
  return data
}

let fetchInfo = {
  data: null
}

const request = async (pathname) => {
  return new Promise((rev, rej) => {
    let timer = setTimeout(() => {
      rej(`加载${pathname}超时`)
    }, config.timeout * 1000)
    const url = pathname.startsWith('https://') ? pathname: `${origin}${pathname}`
    fetch(url)
    .then(res => {
      clearTimeout(timer)
      if (!res.ok) {
        rej(`${res.status} ${res.url}`)
        return ''
      }
      const type = res.headers.get('content-type')
      if (type?.includes('json')) {
        return res.json()
      }
      return res.text()
    }).then(rev).catch(rej)
  })
}

const getHash = new Promise((rev, rej) => {
  getManifest().then(data => {
    fetchInfo.data = data
    config.newVersion = data.version
    config.hashes = data.hashes
    rev(data)
  }).catch(rej)
})

const fetchWithHash = async (pathname, hash) => {
  if (!hash) {
    const { hashes } = await getHash
    const key = pathname.replace(/^\/(data\/)?/, '')
    hash = hashes[key]
  }
  const data = await request(`${pathname}${hash ? `?v=${hash}` : ''}`)
  return data
}

export default fetchWithHash
export { getHash, fetchInfo }
