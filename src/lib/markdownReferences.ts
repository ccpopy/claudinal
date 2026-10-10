/** Annotate the Markdown AST before conversion to HTML; CSS cannot identify code blocks. */
interface MarkdownNode {
  type: string
  data?: { hProperties?: Record<string, unknown>; [key: string]: unknown }
  children?: MarkdownNode[]
}

export function remarkReferenceSources() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      const source = node.type === "inlineCode" ? "inline_code" : node.type === "code" ? "code_block" : node.type === "link" ? "markdown_link" : null
      if (source) {
        node.data ??= {}
        node.data.hProperties = { ...node.data.hProperties, "data-reference-source": source }
      }
      node.children?.forEach(visit)
    }
    visit(tree)
  }
}
