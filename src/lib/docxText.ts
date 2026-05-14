const WORD_DOCUMENT_PATH = "word/document.xml"

function u16(view: DataView, offset: number): number {
  return view.getUint16(offset, true)
}

function u32(view: DataView, offset: number): number {
  return view.getUint32(offset, true)
}

function decodeXmlText(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
    (entity, body: string) => {
      const key = body.toLowerCase()
      if (key === "amp") return "&"
      if (key === "lt") return "<"
      if (key === "gt") return ">"
      if (key === "quot") return '"'
      if (key === "apos") return "'"
      if (key.startsWith("#x")) {
        return String.fromCodePoint(Number.parseInt(key.slice(2), 16))
      }
      if (key.startsWith("#")) {
        return String.fromCodePoint(Number.parseInt(key.slice(1), 10))
      }
      return entity
    }
  )
}

export function extractWordDocumentXmlText(xml: string): string {
  return xml
    .split(/<\/w:p>/gi)
    .map((paragraph) => {
      let text = ""
      const re =
        /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:(?:br|cr)\b[^>]*\/>/gi
      let match: RegExpExecArray | null
      while ((match = re.exec(paragraph)) !== null) {
        if (match[1] !== undefined) {
          text += decodeXmlText(match[1])
        } else if (match[0].startsWith("<w:tab")) {
          text += "\t"
        } else {
          text += "\n"
        }
      }
      return text.trimEnd()
    })
    .filter((paragraph) => paragraph.trim())
    .join("\n")
}

function findEndOfCentralDirectory(view: DataView): number {
  for (let offset = view.byteLength - 22; offset >= 0; offset -= 1) {
    if (u32(view, offset) === 0x06054b50) return offset
  }
  throw new Error("DOCX zip end-of-central-directory record not found")
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const formats: CompressionFormat[] = ["deflate-raw", "deflate"]
  let lastError: unknown = null
  for (const format of formats) {
    try {
      const input = new Uint8Array(bytes.byteLength)
      input.set(bytes)
      const stream = new Blob([input.buffer]).stream().pipeThrough(
        new DecompressionStream(format)
      )
      return new Uint8Array(await new Response(stream).arrayBuffer())
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`DOCX deflate decompression failed: ${String(lastError)}`)
}

async function readZipEntry(
  buffer: ArrayBuffer,
  targetPath: string
): Promise<Uint8Array> {
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)
  const eocdOffset = findEndOfCentralDirectory(view)
  const entryCount = u16(view, eocdOffset + 10)
  let offset = u32(view, eocdOffset + 16)
  const decoder = new TextDecoder()

  for (let i = 0; i < entryCount; i += 1) {
    if (u32(view, offset) !== 0x02014b50) {
      throw new Error("DOCX zip central directory is malformed")
    }

    const method = u16(view, offset + 10)
    const compressedSize = u32(view, offset + 20)
    const fileNameLength = u16(view, offset + 28)
    const extraLength = u16(view, offset + 30)
    const commentLength = u16(view, offset + 32)
    const localHeaderOffset = u32(view, offset + 42)
    const nameStart = offset + 46
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + fileNameLength))

    if (name === targetPath) {
      if (u32(view, localHeaderOffset) !== 0x04034b50) {
        throw new Error("DOCX zip local file header is malformed")
      }
      const localNameLength = u16(view, localHeaderOffset + 26)
      const localExtraLength = u16(view, localHeaderOffset + 28)
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength
      const compressed = bytes.subarray(dataStart, dataStart + compressedSize)
      if (method === 0) return compressed
      if (method === 8) return inflateRaw(compressed)
      throw new Error(`Unsupported DOCX zip compression method: ${method}`)
    }

    offset = nameStart + fileNameLength + extraLength + commentLength
  }

  throw new Error(`DOCX entry not found: ${targetPath}`)
}

export async function extractDocxText(buffer: ArrayBuffer): Promise<string> {
  const documentXml = new TextDecoder().decode(
    await readZipEntry(buffer, WORD_DOCUMENT_PATH)
  )
  return extractWordDocumentXmlText(documentXml)
}
