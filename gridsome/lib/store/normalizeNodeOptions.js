const hash = require('hash-sum')
const crypto = require('crypto')
const { pick, omit } = require('lodash')
const { NODE_FIELDS } = require('../utils/constants')

module.exports = function normalizeNodeOptions (options, contentType, useFallbacks) {
  if (typeof options === 'string') {
    options = { id: options }
  }

  const nodeOptions = pick(options, NODE_FIELDS)
  const customFields = omit(options, NODE_FIELDS)

  // TODO: remove before 1.0
  if (customFields.fields) {
    Object.assign(customFields, customFields.fields)
    delete customFields.fields
  }

  nodeOptions.internal = createInternal(contentType, nodeOptions.internal)

  if (useFallbacks) {
    if (!nodeOptions.id) {
      nodeOptions.id = hash(options)
    }
    if (!nodeOptions.$uid) {
      nodeOptions.$uid = genUid(contentType.typeName + nodeOptions.id)
    }
  }

  // TODO: remove before 1.0
  if (nodeOptions._id) nodeOptions.id = nodeOptions._id

  return { ...customFields, ...nodeOptions }
}

function genUid (value) {
  return crypto.createHash('md5').update(value).digest('hex')
}

function createInternal (contentType, internal = {}) {
  return {
    typeName: contentType.typeName,
    origin: internal.origin,
    mimeType: internal.mimeType,
    content: internal.content,
    timestamp: Date.now()
  }
}
