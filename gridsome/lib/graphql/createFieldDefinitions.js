const { omit, isPlainObject, isNumber, isInteger } = require('lodash')
const { isRefFieldDefinition } = require('./utils')
const { isRefField } = require('../store/utils')
const { warn } = require('../utils/log')

module.exports = function createFieldDefinitions (nodes) {
  let res = {}

  for (let i = 0, l = nodes.length; i < l; i++) {
    const fields = omit(nodes[i], ['internal'])
    res = resolveValues(fields, res)
  }

  return res
}

function resolveValues (obj, currentObj = {}, path = []) {
  const res = { ...currentObj }

  for (const key in obj) {
    const value = obj[key]

    if (key.startsWith('$')) continue
    if (key.startsWith('__')) continue
    if (value === undefined) continue
    if (value === null) continue

    const fieldName = createFieldName(key)
    const currentValue = currentObj[key] ? currentObj[key].value : undefined
    const resolvedValue = resolveValue(value, currentValue, path.concat(key))
    const extensions = { isInferred: true }

    if (fieldName !== key) {
      extensions.proxy = {
        from: key
      }
    }

    res[key] = {
      key,
      fieldName,
      extensions,
      value: resolvedValue
    }
  }

  return res
}

function resolveValue (value, currentValue, path = []) {
  if (Array.isArray(value)) {
    const arr = Array.isArray(currentValue) ? currentValue : []
    const length = value.length

    if (isRefField(value[0])) {
      if (!isRefFieldDefinition(currentValue)) {
        currentValue = { typeName: [], isList: true }
      }

      for (let i = 0; i < length; i++) {
        if (!value[i].typeName) {
          warn(`Missing typeName for reference at: ${path.join('.')}.${i}`)
        } else if (!currentValue.typeName.includes(value[i].typeName)) {
          currentValue.typeName.push(value[i].typeName)
        }
      }

      return currentValue
    }

    if (isRefFieldDefinition(currentValue)) {
      return currentValue
    }

    for (let i = 0; i < length; i++) {
      arr[0] = resolveValue(value[i], arr[0], path.concat(i))
    }

    return arr
  } else if (isPlainObject(value)) {
    if (isRefField(value)) {
      if (!value.typeName) {
        warn(`Missing typeName for reference in field: ${path.join('.')}`)
        return currentValue
      }

      const ref = currentValue || { typeName: value.typeName }
      ref.isList = ref.isList || Array.isArray(value.id)

      return ref
    }

    return resolveValues(value, currentValue, path)
  } else if (isNumber(value)) {
    return isNumber(currentValue) && isInteger(value)
      ? currentValue
      : value
  }

  return currentValue !== undefined ? currentValue : value
}

const nonValidCharsRE = new RegExp('[^a-zA-Z0-9_]', 'g')
const leadingNumberRE = new RegExp('^([0-9])')

function createFieldName (key) {
  return key
    .replace(nonValidCharsRE, '_')
    .replace(leadingNumberRE, '_$1')
}
