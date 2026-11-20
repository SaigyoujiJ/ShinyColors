/**
 * 单次重试：最多执行 2 次（首次 + 失败后重试 1 次）。
 *
 * - fn 抛异常，或返回值不满足 isOk，都算失败。
 * - 两次都失败时返回最后一次的结果（可能为 null / []），由调用方决定如何降级。
 * - 重试前等待 delay 毫秒，不做指数退避，也不无限重试。
 */
const sleep = (ms) => new Promise(rev => setTimeout(rev, ms))

const retryOnce = async (fn, isOk, label = 'request', delay = 500) => {
  let last = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      last = await fn(attempt)
      if (isOk(last)) return last
    } catch (e) {
      last = null
      console.warn(`[sczh] ${label} 第 ${attempt + 1} 次请求异常`, e)
    }
    if (attempt === 0) {
      console.warn(`[sczh] ${label} 失败，重试 1 次`)
      await sleep(delay)
    }
  }
  return last
}

export { sleep }
export default retryOnce
