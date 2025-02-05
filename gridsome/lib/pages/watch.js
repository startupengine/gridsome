const { debounce } = require('lodash')

module.exports = (app, pages) => {
  const createPages = debounce(() => app.plugins.createPages(), 16)
  const fetchQueries = debounce(() => app.broadcast({ type: 'fetch' }), 16)
  const generateRoutes = debounce(() => app.codegen.generate('routes.js'), 16)

  app.store.on('change', () => app.isBootstrapped ? createPages() : null)
  pages._routes.on('insert', () => app.isBootstrapped ? generateRoutes() : null)
  pages._routes.on('delete', () => app.isBootstrapped ? generateRoutes() : null)

  pages._routes.on('update', (route, oldRoute) => {
    if (!app.isBootstrapped) return

    if (oldRoute.path !== route.path) {
      return generateRoutes()
    }

    fetchQueries()
  })

  pages._watcher.on('change', component => {
    if (!app.isBootstrapped) return

    const routes = pages._routes.find({ component })
    const length = routes.length

    pages.disableIndices()

    for (let i = 0; i < length; i++) {
      const { type, name, path, internal } = routes[i]
      const options = { type, name, path, component }

      pages.updateRoute(options, {
        digest: internal.digest,
        isManaged: internal.isManaged
      })
    }

    pages.enableIndices()
  })
}
