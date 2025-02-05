const path = require('path')
const fs = require('fs-extra')
const LRU = require('lru-cache')
const crypto = require('crypto')
const invariant = require('invariant')
const initWatcher = require('./watch')
const { Collection } = require('lokijs')
const { FSWatcher } = require('chokidar')
const { parseQuery } = require('../graphql')
const pathToRegexp = require('path-to-regexp')
const createPageQuery = require('./createPageQuery')
const { HookMap, SyncWaterfallHook, SyncBailHook } = require('tapable')
const validateInput = require('./schemas')
const { snakeCase } = require('lodash')

const TYPE_STATIC = 'static'
const TYPE_DYNAMIC = 'dynamic'
const isDev = process.env.NODE_ENV === 'development'

const createHash = value => crypto.createHash('md5').update(value).digest('hex')
const getRouteType = value => /:/.test(value) ? TYPE_DYNAMIC : TYPE_STATIC

class Pages {
  constructor (app) {
    this.app = app

    this.hooks = {
      parseComponent: new HookMap(() => new SyncBailHook(['source', 'resource'])),
      createRoute: new SyncWaterfallHook(['options']),
      createPage: new SyncWaterfallHook(['options'])
    }

    this._componentCache = new LRU({ max: 100 })
    this._queryCache = new LRU({ max: 100 })
    this._watched = new Map()
    this._watcher = null

    ;['routes', 'pages'].forEach(name => {
      this[`_${name}`] = new Collection(name, {
        indices: ['id'],
        unique: ['id', 'path'],
        disableMeta: true
      })
    })

    if (isDev) {
      this._watcher = new FSWatcher({
        disableGlobbing: true
      })

      initWatcher(app, this)
    }
  }

  routes () {
    return this._routes
      .chain()
      .simplesort('internal.priority', true)
      .data()
      .map(route => {
        return new Route(route, this)
      })
  }

  pages () {
    return this._pages.data.slice()
  }

  clearCache () {
    this._componentCache.reset()
    this._queryCache.reset()
  }

  clearComponentCache (component) {
    this._componentCache.del(component)
    this._queryCache.del(component)
  }

  disableIndices () {
    ['_routes', '_pages'].forEach(prop => {
      this[prop].configureOptions({
        adaptiveBinaryIndices: false
      })
    })
  }

  enableIndices () {
    ['_routes', '_pages'].forEach(prop => {
      this[prop].ensureAllIndexes()
      this[prop].configureOptions({
        adaptiveBinaryIndices: true
      })
    })
  }

  createRoute (input, meta = {}) {
    const validated = validateInput('route', input)
    const options = this._createRouteOptions(validated, meta)
    const oldRoute = this._routes.by('id', options.id)

    if (oldRoute) {
      const newOptions = Object.assign({}, options, {
        $loki: oldRoute.$loki,
        meta: oldRoute.meta
      })

      this._routes.update(newOptions)

      return new Route(newOptions, this)
    }

    this._routes.insert(options)
    this._watchComponent(options.component)

    return new Route(options, this)
  }

  updateRoute (input, meta = {}) {
    const validated = validateInput('route', input)

    this.clearComponentCache(
      this.app.resolve(validated.component)
    )

    const options = this._createRouteOptions(validated, meta)
    const route = this._routes.by('id', options.id)
    const newOptions = Object.assign({}, options, {
      $loki: route.$loki,
      meta: route.meta
    })

    this._routes.update(newOptions)

    return new Route(newOptions, this)
  }

  removeRoute (id) {
    const options = this._routes.by('id', id)

    this._pages.findAndRemove({ 'internal.route': id })
    this._routes.findAndRemove({ id })
    this._unwatchComponent(options.component)
  }

  createPage (input, meta = {}) {
    const options = validateInput('page', input)
    const type = getRouteType(options.path)

    const route = this.createRoute({
      type,
      path: options.path,
      component: options.component,
      name: options.route.name,
      meta: options.route.meta
    }, meta)

    return route.addPage({
      id: options.id,
      path: options.path,
      context: options.context,
      queryVariables: options.queryVariables
    })
  }

  updatePage (input, meta = {}) {
    const options = validateInput('page', input)
    const type = getRouteType(options.path)

    const route = this.updateRoute({
      type,
      name: options.name,
      path: options.path,
      component: options.component,
      meta: options.route.meta
    }, meta)

    return route.updatePage({
      id: options.id,
      path: options.path,
      context: options.context,
      queryVariables: options.queryVariables
    })
  }

  removePage (id) {
    const page = this.getPage(id)
    const route = this.getRoute(page.internal.route)

    if (route.internal.isDynamic) {
      route.removePage(id)
    } else {
      this.removeRoute(route.id)
    }
  }

  removePageByPath (path) {
    const page = this._pages.by('path', path)

    if (page) {
      this.removePage(page.id)
    }
  }

  removePagesByComponent (path) {
    const component = this.app.resolve(path)

    this._routes
      .find({ component })
      .forEach(options => {
        this.removeRoute(options.id)
      })
  }

  getRoute (id) {
    const options = this._routes.by('id', id)
    return options ? new Route(options, this) : null
  }

  getMatch (path) {
    let route = this._routes.by('path', path)

    if (!route) {
      const chain = this._routes.chain().simplesort('internal.priority', true)

      route = chain.data().find(route =>
        route.internal.regexp.test(path)
      )
    }

    if (route) {
      const { internal } = route
      const length = internal.keys.length
      const m = internal.regexp.exec(path)
      const params = {}

      for (var i = 0; i < length; i++) {
        const key = internal.keys[i]
        const param = m[i + 1]

        if (!param) continue

        params[key.name] = decodeURIComponent(param)

        if (key.repeat) {
          params[key.name] = params[key.name].split(key.delimiter)
        }
      }

      return {
        route: new Route(route, this),
        params
      }
    }
  }

  getPage (id) {
    return this._pages.by('id', id)
  }

  _createRouteOptions (options, meta = {}) {
    const component = this.app.resolve(options.component)
    const { pageQuery } = this._parseComponent(component)
    const parsedQuery = this._parseQuery(pageQuery, component)
    const { source, document, paginate } = this._createPageQuery(parsedQuery)

    const type = options.type
    const originalPath = options.path.replace(/\/+/g, '/')
    const hasTrailingSlash = /\/$/.test(options.path)
    const isDynamic = /:/.test(options.path)
    let path = originalPath
    let name = options.name

    const keys = []
    const regexp = pathToRegexp(path, keys)
    const id = options.id || createHash(`route-${originalPath}`)

    if (type === TYPE_DYNAMIC) {
      name = name || `__${snakeCase(path)}`
    }

    if (paginate) {
      const prefix = hasTrailingSlash ? '' : '/'
      const suffix = hasTrailingSlash ? '/' : ''
      path += `${prefix}:page(\\d+)?${suffix}`
    }

    const priority = this._resolvePriority(path)

    return this.hooks.createRoute.call({
      id,
      type,
      name,
      path,
      component,
      internal: Object.assign({}, meta, {
        meta: options.meta || {},
        path: originalPath,
        isDynamic,
        priority,
        regexp,
        keys,
        query: {
          source,
          document,
          paginate: !!paginate
        }
      })
    })
  }

  _parseQuery (query, component) {
    if (this._queryCache.has(component)) {
      return this._queryCache.get(component)
    }

    const schema = this.app.schema.getSchema()
    const res = parseQuery(schema, query, component)

    this._queryCache.set(component, res)

    return res
  }

  _createPageQuery (parsedQuery, vars = {}) {
    return createPageQuery(parsedQuery, vars)
  }

  _resolvePriority (path) {
    const segments = path.split('/').filter(Boolean)
    const scores = segments.map(segment => {
      let score = Math.max(segment.charCodeAt(0) || 0, 90)
      const parts = (segment.match(/-/g) || []).length

      if (/^:/.test(segment)) score -= 10
      if (/:/.test(segment)) score -= 10
      if (/\(.*\)/.test(segment)) score += 5
      if (/\/[^:]$/.test(segment)) score += 3
      if (/(\?|\+|\*)$/.test(segment)) score -= 3
      if (/\(\.\*\)/.test(segment)) score -= 10
      if (parts) score += parts

      return score
    })

    return scores.reduce(
      (sum, score) => sum + score,
      segments.length * 100
    )
  }

  _parseComponent (component) {
    if (this._componentCache.has(component)) {
      return this._componentCache.get(component)
    }

    const ext = path.extname(component).substring(1)
    const hook = this.hooks.parseComponent.get(ext)
    let results

    if (hook) {
      const source = fs.readFileSync(component, 'utf8')
      results = hook.call(source, { resourcePath: component })
    }

    this._componentCache.set(component, validateInput('component', results || {}))

    return results
  }

  _watchComponent (component) {
    if (!this._watched.has(component)) {
      this._watched.set(component, true)
      if (this._watcher) this._watcher.add(component)
    }
  }

  _unwatchComponent (component) {
    if (this._routes.find({ component }).length <= 0) {
      this._watched.delete(component)
      if (this._watcher) this._watcher.unwatch(component)
    }
  }
}

class Route {
  constructor (options, factory) {
    this.type = options.type
    this.id = options.id
    this.name = options.name
    this.path = options.path
    this.component = options.component
    this.internal = options.internal
    this.options = options

    Object.defineProperty(this, '_factory', { value: factory })
    Object.defineProperty(this, '_pages', { value: factory._pages })
    Object.defineProperty(this, '_createPage', { value: factory.hooks.createPage })
  }

  pages () {
    return this._pages.find({
      'internal.route': this.id
    })
  }

  addPage (input) {
    const options = this._createPageOptions(input)
    const oldPage = this._pages.by('id', options.id)

    if (oldPage) {
      options.$loki = oldPage.$loki
      options.meta = oldPage.meta

      this._pages.update(options)
    } else {
      this._pages.insert(options)
    }

    // TODO: warn if a page exists whith and without trailing slash

    return options
  }

  updatePage (input) {
    const options = this._createPageOptions(input)
    const oldOptions = this._pages.by('id', options.id)

    if (!oldOptions) {
      throw new Error(
        `Cannot update page "${options.path}". ` +
        `Existing page with id "${options.id}" could not be found.`
      )
    }

    const newOptions = Object.assign({}, options, {
      $loki: oldOptions.$loki,
      meta: oldOptions.meta
    })

    this._pages.update(newOptions)

    return newOptions
  }

  removePage (id) {
    this._pages.findAndRemove({ id, 'internal.route': this.id })
  }

  _createPageOptions (input) {
    const { regexp, digest, isManaged, query } = this.internal
    const { id: _id, path: _path, context, queryVariables } = validateInput('routePage', input)
    const originalPath = _path.replace(/\/+/g, '/')
    const isDynamic = /:/.test(originalPath)
    const id = _id || createHash(`page-${originalPath}`)

    if (this.type === TYPE_STATIC) {
      invariant(
        regexp.test(originalPath),
        `Page path does not match route path: ${originalPath}`
      )
    }

    if (this.type === TYPE_DYNAMIC) {
      invariant(
        this.internal.path === originalPath,
        `Dynamic page must equal the route path: ${this.internal.path}`
      )
    }

    const vars = queryVariables || context || {}
    const parsedQuery = this._factory._parseQuery(query.source, this.component)
    const { paginate, variables, filters } = this._factory._createPageQuery(parsedQuery, vars)

    return this._createPage.call({
      id,
      path: originalPath,
      context,
      internal: {
        route: this.id,
        digest,
        isManaged,
        isDynamic,
        query: {
          paginate,
          variables,
          filters
        }
      }
    })
  }
}

module.exports = Pages
