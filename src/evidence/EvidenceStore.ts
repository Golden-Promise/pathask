import type { EvidenceEdge, EvidenceGraph, EvidenceNode, EvidenceRelation } from '../types'

let counter = 0
function nextGlobalId(prefix: string): string {
  counter += 1
  return `${prefix}-${counter}`
}

/**
 * 会话级证据库（闭包 Session 持有，不走 ExtensionContext——pi-agent-core 没有它）。
 * 工具 execute 通过闭包捕获的 `PathAskSession.evidenceStore` 读写证据。
 */
export class EvidenceStore {
  private nodes = new Map<string, EvidenceNode>()
  private edges: EvidenceEdge[] = []

  nextId(prefix = 'ev'): string {
    return nextGlobalId(prefix)
  }

  addNode(node: EvidenceNode): EvidenceNode {
    this.nodes.set(node.id, node)
    return node
  }

  addEdge(from: string, to: string, relation: EvidenceRelation, strength: number): void {
    this.edges.push({ from, to, relation, strength })
  }

  getNode(id: string): EvidenceNode | undefined {
    return this.nodes.get(id)
  }

  allNodes(): EvidenceNode[] {
    return [...this.nodes.values()]
  }

  nodesOfType(type: EvidenceNode['type']): EvidenceNode[] {
    return this.allNodes().filter((n) => n.type === type)
  }

  getGraph(): EvidenceGraph {
    return { nodes: this.allNodes(), edges: [...this.edges] }
  }

  /** leave-one-out：临时移除一个节点及其关联边，返回以便 restore 还原 */
  removeNode(id: string): { node: EvidenceNode; edges: EvidenceEdge[] } {
    const node = this.nodes.get(id)
    if (!node) return { node: undefined as unknown as EvidenceNode, edges: [] }
    const removedEdges = this.edges.filter((e) => e.from === id || e.to === id)
    this.nodes.delete(id)
    this.edges = this.edges.filter((e) => e.from !== id && e.to !== id)
    return { node, edges: removedEdges }
  }

  restore(node: EvidenceNode, edges: EvidenceEdge[]): void {
    this.nodes.set(node.id, node)
    this.edges.push(...edges)
  }

  addFollowUp(id: string, question: string): void {
    const node = this.nodes.get(id)
    if (node) node.follow_up_questions = [...(node.follow_up_questions ?? []), question]
  }

  summarize(): string {
    return this.allNodes()
      .map((n) => `[${n.id}](${n.type}, ${n.source.tool}) ${n.claim} conf=${n.confidence.toFixed(2)}`)
      .join('\n')
  }
}
