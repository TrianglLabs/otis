export function compareVersions(left: string, right: string) {
  if (left === right) return 0
  const leftParts = parseVersionParts(left)
  const rightParts = parseVersionParts(right)
  if (!leftParts) throw new Error(`Current version is not valid semver: ${left}`)
  if (!rightParts) throw new Error(`Release version is not valid semver: ${right}`)

  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1
    if (leftParts[index] < rightParts[index]) return -1
  }

  const leftPrerelease = parsePrerelease(left)
  const rightPrerelease = parsePrerelease(right)
  if (!leftPrerelease && !rightPrerelease) return 0
  if (!leftPrerelease) return 1
  if (!rightPrerelease) return -1
  return comparePrerelease(leftPrerelease, rightPrerelease)
}

export function normalizeVersion(value: string) {
  return value.trim().replace(/^v/, "")
}

export function validateVersion(label: string, version: string) {
  if (!parseVersionParts(version)) throw new Error(`${label} is not valid semver: ${version}`)
}

function parseVersionParts(version: string) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}

function parsePrerelease(version: string) {
  return /^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+.*)?$/.exec(version)?.[4]?.split(".")
}

function comparePrerelease(left: string[], right: string[]) {
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left[index]
    const rightIdentifier = right[index]
    if (leftIdentifier === undefined) return -1
    if (rightIdentifier === undefined) return 1

    const leftNumber = numericIdentifier(leftIdentifier)
    const rightNumber = numericIdentifier(rightIdentifier)
    if (leftNumber !== undefined && rightNumber === undefined) return -1
    if (leftNumber === undefined && rightNumber !== undefined) return 1
    if (leftNumber !== undefined && rightNumber !== undefined) {
      if (leftNumber !== rightNumber) return leftNumber > rightNumber ? 1 : -1
    } else if (leftIdentifier !== rightIdentifier) {
      return leftIdentifier > rightIdentifier ? 1 : -1
    }
  }
  return 0
}

function numericIdentifier(identifier: string) {
  return /^\d+$/.test(identifier) ? Number(identifier) : undefined
}
