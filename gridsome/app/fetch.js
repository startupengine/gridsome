import prefetch from './utils/prefetch'
import { unslashEnd, stripPageParam } from './utils/helpers'
import { NOT_FOUND_PATH } from '~/.temp/constants'

const dataUrl = process.env.DATA_URL
const isPrefetched = {}
const isLoaded = {}

export default (route, options = {}) => {
  const { shouldPrefetch = false, force = false } = options

  if (!process.isStatic) {
    const path = route.meta.dynamic
      ? route.matched[0].path
      : route.name === '*'
        ? NOT_FOUND_PATH
        : stripPageParam(route)

    const getJSON = function (route) {
      return new Promise((resolve, reject) => {
        fetch(process.env.GRAPHQL_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            page: route.params.page ? Number(route.params.page) : null,
            path
          })
        })
          .then(res => res.json())
          .then(resolve)
          .catch(reject)
      })
    }

    return new Promise((resolve, reject) => {
      if (force || !isLoaded[route.fullPath]) {
        isLoaded[route.fullPath] = getJSON(route)
      }

      isLoaded[route.fullPath]
        .then(res => {
          if (res.errors) reject(res.errors[0])
          else if (res.code) resolve({ code: res.code })
          else resolve({
            data: res.data,
            context: res.extensions
              ? res.extensions.context
              : {}
          })
        })
        .catch(reject)
    })
  }

  const hashMeta = document
    .querySelector('meta[name="gridsome:hash"]')
    .getAttribute('content')

  return new Promise((resolve, reject) => {
    const usePath = route.name === '*' ? NOT_FOUND_PATH : route.path
    const jsonPath = route.meta.dataPath || unslashEnd(usePath) + '/index.json'
    const absPath = unslashEnd(dataUrl) + jsonPath

    if (shouldPrefetch && !isLoaded[jsonPath]) {
      if (!isPrefetched[jsonPath]) {
        isPrefetched[jsonPath] = prefetch(absPath)
      }

      return isPrefetched[jsonPath]
        .then(() => resolve())
        .catch(() => resolve())
    }

    if (!isLoaded[jsonPath]) {
      isLoaded[jsonPath] = fetchJSON(absPath)
    }

    return isLoaded[jsonPath]
      .then(res => {
        if (res.hash !== hashMeta) reject(createError('Hash did not match.', 'INVALID_HASH'))
        else resolve(res)
      })
      .catch(reject)
  })
}

function createError (message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

function fetchJSON (jsonPath) {
  return new Promise((resolve, reject) => {
    const req = new XMLHttpRequest()

    req.open('GET', jsonPath, true)
    req.withCredentials = true

    req.onload = () => {
      switch (req.status) {
        case 200: {
          let results

          try {
            results = JSON.parse(req.responseText)
          } catch (err) {
            return reject(
              new Error(`Failed to parse JSON from ${jsonPath}. ${err.message}.`)
            )
          }

          if (!results.hash) {
            return reject(
              new Error(`JSON data in ${jsonPath} is missing a hash.`)
            )
          }

          return resolve(results)
        }
        case 404: {
          return reject(createError(req.statusText, req.status))
        }
      }

      reject(new Error(`Failed to fetch ${jsonPath}.`))
    }

    req.send(null)
  })
}
