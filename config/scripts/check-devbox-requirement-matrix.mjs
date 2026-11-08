import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const defaultMatrixPath = path.join(repoRoot, 'docs', 'requirements-matrix.md')
const matrixPath = process.env.DEVBOX_REQUIREMENT_MATRIX_PATH
  ? path.resolve(process.env.DEVBOX_REQUIREMENT_MATRIX_PATH)
  : defaultMatrixPath
const requirementIds = Array.from(
  { length: 25 },
  (_value, index) => `R-${String(index + 1).padStart(3, '0')}`
)
const projectPathPattern = /`([^`\s]+\/[^`\s]+)`/gu
const allowedPathPattern = /^(?:config|docs|src|tests|scripts)\//u
const testFilePattern = /\.(?:spec|test)\.(?:c|m)?(?:js|ts|jsx|tsx)$/u
const placeholderPattern = /(?:TODO|FIXME|TBD|placeholder|coming soon|fill in|not yet)/iu

function parseMatrixRows(matrix) {
  return matrix
    .split('\n')
    .filter((line) => /^\|\s*R-\d{3}\b[^|]*\|/u.test(line))
    .map((line) => {
      const cells = line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim())
      if (cells.length !== 4) {
        throw new Error(`Requirement row has ${cells.length} cells instead of 4: ${line}`)
      }
      return {
        id: cells[0].match(/^R-\d{3}/u)?.[0] ?? '',
        requirement: cells[0],
        tasks: cells[1],
        classification: cells[2],
        evidence: cells[3]
      }
    })
}

function referencedPaths(evidence) {
  return [...evidence.matchAll(projectPathPattern)].map((match) => match[1])
}

async function verifyReferencedFiles(id, evidence) {
  const paths = referencedPaths(evidence)
  const testFiles = []
  const missing = []

  for (const relativePath of paths) {
    if (!allowedPathPattern.test(relativePath)) {
      throw new Error(`${id} references a path outside the repository allowlist: ${relativePath}`)
    }
    const candidate = path.resolve(repoRoot, relativePath)
    if (!candidate.startsWith(`${repoRoot}${path.sep}`)) {
      throw new Error(`${id} references a path outside the repository: ${relativePath}`)
    }
    let details
    try {
      details = await stat(candidate)
    } catch {
      missing.push(relativePath)
      continue
    }
    if (!details.isFile()) {
      throw new Error(`${id} references a non-file evidence path: ${relativePath}`)
    }
    if (testFilePattern.test(relativePath)) {
      testFiles.push(relativePath)
    }
  }

  if (missing.length) {
    throw new Error(`${id} references missing evidence path(s): ${missing.join(', ')}`)
  }
  return testFiles
}

async function main() {
  const matrix = await readFile(matrixPath, 'utf8')
  const rows = parseMatrixRows(matrix)
  const rowIds = rows.map((row) => row.id)

  if (rows.length !== requirementIds.length || new Set(rowIds).size !== requirementIds.length) {
    throw new Error(
      `Devbox requirement matrix must contain exactly ${requirementIds.length} unique rows; found ${rows.length}.`
    )
  }

  let verifiedTestFiles = 0
  const missingEvidence = []
  for (const id of requirementIds) {
    const row = rows.find((candidate) => candidate.id === id)
    if (!row) {
      throw new Error(`${id} is missing from the requirement matrix.`)
    }
    if (!row.requirement.slice(id.length).trim() || !row.tasks || !row.classification) {
      throw new Error(`${id} must name its requirement, owning tasks, and classification.`)
    }
    if (!row.evidence || placeholderPattern.test(row.evidence)) {
      throw new Error(`${id} has empty or placeholder release evidence.`)
    }

    try {
      const testFiles = await verifyReferencedFiles(id, row.evidence)
      verifiedTestFiles += testFiles.length
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('missing evidence path')) {
        missingEvidence.push(message)
      } else {
        throw error
      }
    }

    const hasManualPilot = /manual pilot/iu.test(`${row.classification} ${row.evidence}`)
    if (!referencedPaths(row.evidence).length && !hasManualPilot) {
      throw new Error(`${id} must cite a concrete evidence file or an explicit manual pilot step.`)
    }
  }

  const r003 = rows.find((row) => row.id === 'R-003')
  if (!/blocked on mutagen|external transport/iu.test(r003.classification)) {
    throw new Error('R-003 must be marked blocked on Mutagen or external transport.')
  }
  if (!/manual pilot|external transport/iu.test(r003.evidence)) {
    throw new Error('R-003 must identify its real transport evidence as a manual/external step.')
  }

  if (missingEvidence.length) {
    throw new Error(`Missing release evidence paths:\n${missingEvidence.join('\n')}`)
  }

  console.log(
    `Devbox requirement matrix OK — ${requirementIds.length} requirements audited; ` +
      `${verifiedTestFiles} test files verified.`
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main().catch((error) => {
    console.error(
      `Devbox requirement matrix failed: ${error instanceof Error ? error.message : error}`
    )
    process.exitCode = 1
  })
}
