import { describe, expect, it } from "vitest"
import { extractDocxText, extractWordDocumentXmlText } from "./docxText"

function setU16(view: DataView, offset: number, value: number) {
  view.setUint16(offset, value, true)
}

function setU32(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value, true)
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const input = new Uint8Array(bytes.byteLength)
  input.set(bytes)
  const stream = new Blob([input.buffer]).stream().pipeThrough(
    new CompressionStream("deflate-raw")
  )
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function makeZipEntry(
  name: string,
  contentBytes: Uint8Array,
  compressedBytes: Uint8Array,
  method: 0 | 8
): ArrayBuffer {
  const encoder = new TextEncoder()
  const nameBytes = encoder.encode(name)

  const local = new Uint8Array(30 + nameBytes.length + compressedBytes.length)
  const localView = new DataView(local.buffer)
  setU32(localView, 0, 0x04034b50)
  setU16(localView, 8, method)
  setU32(localView, 18, compressedBytes.length)
  setU32(localView, 22, contentBytes.length)
  setU16(localView, 26, nameBytes.length)
  local.set(nameBytes, 30)
  local.set(compressedBytes, 30 + nameBytes.length)

  const central = new Uint8Array(46 + nameBytes.length)
  const centralView = new DataView(central.buffer)
  setU32(centralView, 0, 0x02014b50)
  setU16(centralView, 10, method)
  setU32(centralView, 20, compressedBytes.length)
  setU32(centralView, 24, contentBytes.length)
  setU16(centralView, 28, nameBytes.length)
  setU32(centralView, 42, 0)
  central.set(nameBytes, 46)

  const eocd = new Uint8Array(22)
  const eocdView = new DataView(eocd.buffer)
  setU32(eocdView, 0, 0x06054b50)
  setU16(eocdView, 8, 1)
  setU16(eocdView, 10, 1)
  setU32(eocdView, 12, central.length)
  setU32(eocdView, 16, local.length)

  const zip = concat([local, central, eocd])
  const out = new ArrayBuffer(zip.byteLength)
  new Uint8Array(out).set(zip)
  return out
}

function makeStoredZip(name: string, content: string): ArrayBuffer {
  const contentBytes = new TextEncoder().encode(content)
  return makeZipEntry(name, contentBytes, contentBytes, 0)
}

async function makeDeflatedZip(name: string, content: string): Promise<ArrayBuffer> {
  const contentBytes = new TextEncoder().encode(content)
  return makeZipEntry(name, contentBytes, await deflateRaw(contentBytes), 8)
}

describe("docxText.extractWordDocumentXmlText", () => {
  it("extracts paragraphs, breaks, tabs, and XML entities", () => {
    const xml = [
      "<w:document><w:body>",
      "<w:p><w:r><w:t>第一段 &amp; 内容</w:t></w:r></w:p>",
      "<w:p><w:r><w:t>第二</w:t><w:tab/><w:t>段</w:t><w:br/><w:t>换行</w:t></w:r></w:p>",
      "</w:body></w:document>"
    ].join("")

    expect(extractWordDocumentXmlText(xml)).toBe("第一段 & 内容\n第二\t段\n换行")
  })
})

describe("docxText.extractDocxText", () => {
  it("reads word/document.xml from a DOCX zip", async () => {
    const xml =
      "<w:document><w:body><w:p><w:r><w:t>测试文档正文</w:t></w:r></w:p></w:body></w:document>"
    const zip = makeStoredZip("word/document.xml", xml)

    await expect(extractDocxText(zip)).resolves.toBe("测试文档正文")
  })

  it("inflates compressed word/document.xml entries", async () => {
    const xml =
      "<w:document><w:body><w:p><w:r><w:t>压缩正文</w:t></w:r></w:p></w:body></w:document>"
    const zip = await makeDeflatedZip("word/document.xml", xml)

    await expect(extractDocxText(zip)).resolves.toBe("压缩正文")
  })
})
