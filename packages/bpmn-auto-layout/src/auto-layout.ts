/**
 * Custom Planar BPMN Auto-Layout Engine.
 *
 * Implements a modular grid-based layout algorithm tailored to graph-agent's
 * Camunda 8 BPMN workflows.
 *
 * Principles:
 * - Primary horizontal spine centered at Y=70.
 * - Modular 150px column grid: col 0 at centerX=75, col 1 at 225, col 2 at 375, etc.
 * - Multi-track vertical lanes (Track 0 at Y=70, Track 1 at Y=210, Track 2 at Y=490).
 * - Planar, zero-crossing orthogonal routing with dedicated return/bypass channels
 *   (Channel 1 at Y=140, Channel 2 at Y=280, Channel 3 at Y=560).
 * - Full support for expanded SubProcesses and their internal elements.
 * - Automatic generation of BPMNLabel bounds (width 90, height 20) for all named
 *   events and gateways, satisfying bpmnlint's local/label-layout rule.
 */
import { BpmnModdle } from "bpmn-moddle";
import zeebe from "zeebe-bpmn-moddle/resources/zeebe.json" with { type: "json" };

export interface AutoLayoutOptions {
  colWidth?: number;
  spineY?: number;
  track1Y?: number;
  track2Y?: number;
  trackGap?: number;
  channel1Y?: number;
  channel2Y?: number;
  channel3Y?: number;
}

const DEFAULT_OPTIONS: Required<AutoLayoutOptions> = {
  colWidth: 150,
  spineY: 70,
  track1Y: 210,
  track2Y: 490,
  trackGap: 140,
  channel1Y: 140,
  channel2Y: 280,
  channel3Y: 560,
};

interface ElementDimensions {
  width: number;
  height: number;
}

function getElementDimensions(element: any): ElementDimensions {
  const type = element.$type || "";
  if (type.endsWith("Event")) return { width: 36, height: 36 };
  if (type.endsWith("Gateway")) return { width: 50, height: 50 };
  if (type === "bpmn:SubProcess") return { width: 360, height: 200 };
  return { width: 100, height: 80 };
}

interface NodeLayout {
  id: string;
  element: any;
  col: number;
  track: number;
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  isSubProcessChild?: boolean;
}

interface ProcessLayoutResult {
  nodes: Map<string, NodeLayout>;
  allFlows: any[];
  /** Assigned once per process, before waypoints are computed. See `planChannels`. */
  channels?: ChannelPlan;
}

/**
 * Where a routed edge -- a loop-back, or a forward bypass over intermediate
 * nodes -- runs while it is not alongside its own endpoints.
 *
 * Two things went wrong while these were fixed constants (`channel1Y` 140,
 * `channel2Y` 280, a literal `290` for the `minTrack < 0` case). They were
 * chosen against the *default* track pitch, so once a track was pushed down
 * to clear a tall element (an expanded SubProcess adds 60px of clearance in
 * `extraClearanceForTrack`), a channel that used to sit below the row landed
 * *inside* it: in `pi-default-loop.bpmn` the return channel at Y=290 ran
 * straight through seven nodes whose band is Y=230..310. And because every
 * routed edge on a side shared one Y, two of them were drawn on exactly the
 * same line -- `next_turn` and `followup_again` overlapped for 1500px, which
 * renders as a single edge.
 *
 * So: derive the channel from the band the nodes actually occupy, and give
 * each edge its own lane whenever its span overlaps another's.
 */
interface ChannelPlan {
  /**
   * The Y this flow's channel runs at. During the planning pass this records
   * the request and returns a provisional value; afterwards it returns the
   * lane actually assigned.
   */
  channelY(flowId: string, side: "above" | "below", x1: number, x2: number): number;
}

const CHANNEL_CLEARANCE = 40;
/** How far an edge label may sit past the ends of its own segment. */
const LABEL_SLIDE_SLACK = 45;
const CHANNEL_LANE_GAP = 30;

/**
 * Two passes over the flows: the first records which of them route through a
 * channel and how far they span, the second reads back the lane each was
 * given. Lanes are packed greedily, longest span first, so a long loop-back
 * nests outside a short one rather than crossing it, and two edges only share
 * a lane when their spans do not overlap at all.
 */
function planChannels(nodes: Map<string, NodeLayout>): {
  recorder: ChannelPlan;
  resolve: () => ChannelPlan;
} {
  const tops: NodeLayout[] = [];
  for (const n of nodes.values()) if (!n.isSubProcessChild) tops.push(n);
  const bandTop = tops.length ? Math.min(...tops.map((n) => n.y)) : 0;
  const bandBottom = tops.length ? Math.max(...tops.map((n) => n.y + n.height)) : 0;

  const laneY = (side: "above" | "below", lane: number): number =>
    side === "below"
      ? bandBottom + CHANNEL_CLEARANCE + lane * CHANNEL_LANE_GAP
      : bandTop - CHANNEL_CLEARANCE - lane * CHANNEL_LANE_GAP;

  interface Request {
    flowId: string;
    side: "above" | "below";
    lo: number;
    hi: number;
  }
  const requests: Request[] = [];
  const recorder: ChannelPlan = {
    channelY(flowId, side, x1, x2) {
      requests.push({ flowId, side, lo: Math.min(x1, x2), hi: Math.max(x1, x2) });
      return laneY(side, 0);
    },
  };

  const resolve = (): ChannelPlan => {
    const assigned = new Map<string, number>();
    for (const side of ["below", "above"] as const) {
      const mine = requests.filter((r) => r.side === side).sort((a, b) => b.hi - b.lo - (a.hi - a.lo));
      const lanes: Array<Array<{ lo: number; hi: number }>> = [];
      for (const req of mine) {
        let lane = 0;
        while (
          lanes[lane]?.some((iv) => Math.min(iv.hi, req.hi) - Math.max(iv.lo, req.lo) > 0)
        ) {
          lane += 1;
        }
        (lanes[lane] ??= []).push({ lo: req.lo, hi: req.hi });
        assigned.set(req.flowId, lane);
      }
    }
    return {
      channelY(flowId, side) {
        return laneY(side, assigned.get(flowId) ?? 0);
      },
    };
  };

  return { recorder, resolve };
}

/**
 * A `bpmn:SequenceFlow` whose `sourceRef`/`targetRef` belong to a different
 * immediate flow-element container -- a `bpmn:Process`, or a nested
 * `bpmn:SubProcess` -- than the flow itself, is not valid BPMN: a flow can
 * only connect elements within the exact container that owns it. Left
 * undetected, this used to surface as a bare `Cannot read properties of
 * undefined (reading '$type')` deep in track/waypoint computation, which
 * named neither the flow nor why it was malformed -- first at the
 * `bpmn:Process` boundary (issue #94), then one container down at a
 * `bpmn:SubProcess` boundary (issue #100), since attributing every element
 * to its top-level process id (rather than its *immediate* container) means
 * a cross-subprocess-but-same-process flow slips straight through.
 * `applyGraphOps`/`checkSplice` (graph.ts) now refuse to produce this shape
 * in the first place, but a hand-written or externally-supplied document
 * could still reach here, so this names the problem up front rather than
 * crashing partway through layout.
 */
function assertNoCrossProcessFlows(processes: any[]): void {
  const containerOf = new Map<string, string>();
  const visit = (nodes: any[], containerId: string): void => {
    for (const node of nodes) {
      containerOf.set(node.id, containerId);
      if (node.flowElements) visit(node.flowElements, node.$type === "bpmn:SubProcess" ? node.id : containerId);
    }
  };
  for (const process of processes) {
    visit(process.flowElements || [], process.id);
  }
  for (const flow of processes.flatMap((process) => flattenFlowsOf(process.flowElements || []))) {
    const ownContainer = containerOf.get(flow.id);
    const srcContainer = flow.sourceRef && containerOf.get(flow.sourceRef.id);
    const tgtContainer = flow.targetRef && containerOf.get(flow.targetRef.id);
    if (srcContainer && srcContainer !== ownContainer) {
      throw new Error(
        `${flow.id} belongs to '${ownContainer}' but its source '${flow.sourceRef.id}' lives in '${srcContainer}' -- a sequence flow cannot cross between processes or subprocesses`,
      );
    }
    if (tgtContainer && tgtContainer !== ownContainer) {
      throw new Error(
        `${flow.id} belongs to '${ownContainer}' but its target '${flow.targetRef.id}' lives in '${tgtContainer}' -- a sequence flow cannot cross between processes or subprocesses`,
      );
    }
  }
}

function flattenFlowsOf(nodes: any[]): any[] {
  return nodes.flatMap((node) => [
    ...(node.$type === "bpmn:SequenceFlow" ? [node] : []),
    ...(node.flowElements ? flattenFlowsOf(node.flowElements) : []),
  ]);
}

export async function layoutProcess(xml: string, options: AutoLayoutOptions = {}): Promise<string> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const moddle = new BpmnModdle({ zeebe });
  const { rootElement } = await moddle.fromXML(xml);
  const root = rootElement as any;

  const processes = (root.rootElements || []).filter((el: any) => el.$type === "bpmn:Process");
  if (processes.length === 0) return xml;

  assertNoCrossProcessFlows(processes);

  // Clean existing diagrams
  root.diagrams = [];

  for (const process of processes) {
    const layout = computeProcessLayout(process, opts);
    createProcessDi(moddle, root, process, layout, opts);
  }

  const { xml: outputXml } = await moddle.toXML(rootElement, { format: true });
  return outputXml;
}

function computeProcessLayout(process: any, opts: Required<AutoLayoutOptions>): ProcessLayoutResult {
  const allFlowElements: any[] = process.flowElements || [];
  const topNodes = allFlowElements.filter((el) => el.$type !== "bpmn:SequenceFlow");
  const topFlows = allFlowElements.filter((el) => el.$type === "bpmn:SequenceFlow");

  const nodesById = new Map<string, any>(topNodes.map((n) => [n.id, n]));
  const incomingFlows = new Map<string, any[]>();
  const outgoingFlows = new Map<string, any[]>();

  for (const node of topNodes) {
    incomingFlows.set(node.id, []);
    outgoingFlows.set(node.id, []);
  }

  for (const flow of topFlows) {
    const src = flow.sourceRef?.id;
    const tgt = flow.targetRef?.id;
    if (src && nodesById.has(src)) outgoingFlows.get(src)!.push(flow);
    if (tgt && nodesById.has(tgt)) incomingFlows.get(tgt)!.push(flow);
  }

  // 1. Detect back-edges (cycles / loop-backs) via DFS
  const startEvent = topNodes.find((n) => n.$type === "bpmn:StartEvent") || topNodes[0];
  const visited = new Set<string>();
  const onStack = new Set<string>();
  const backEdges = new Set<string>(); // flow IDs

  function dfsDetectBackEdges(nodeId: string) {
    visited.add(nodeId);
    onStack.add(nodeId);

    for (const flow of outgoingFlows.get(nodeId) || []) {
      const targetId = flow.targetRef?.id;
      if (!targetId || !nodesById.has(targetId)) continue;

      if (onStack.has(targetId)) {
        backEdges.add(flow.id);
      } else if (!visited.has(targetId)) {
        dfsDetectBackEdges(targetId);
      }
    }

    onStack.delete(nodeId);
  }

  if (startEvent) dfsDetectBackEdges(startEvent.id);

  // 2. Identify the Primary Spine (Track 0)
  // Score paths from startEvent to find the main activity-rich path
  function countActivitiesAlongPath(nodeId: string, seen: Set<string>): number {
    if (seen.has(nodeId)) return 0;
    seen.add(nodeId);
    const node = nodesById.get(nodeId);
    let count = 0;
    if (node && (node.$type.endsWith("Task") || node.$type === "bpmn:CallActivity" || node.$type === "bpmn:SubProcess")) {
      count = 1;
    }

    let maxSub = 0;
    for (const flow of outgoingFlows.get(nodeId) || []) {
      if (backEdges.has(flow.id)) continue;
      const targetId = flow.targetRef?.id;
      if (targetId && nodesById.has(targetId)) {
        maxSub = Math.max(maxSub, countActivitiesAlongPath(targetId, new Set(seen)));
      }
    }
    return count + maxSub;
  }

  function flowSpineScore(flow: any, fromNodeId: string): number {
    const targetId = flow.targetRef?.id;
    const targetNode = nodesById.get(targetId);
    if (!targetNode) return -100;
    if (targetNode.$type === "bpmn:SubProcess") return -50;
    if (flow.name === "no" || flow.name === "reject" || flow.name === "give up") return -50;
    if (flow.name?.toLowerCase().includes("error") || flow.name?.toLowerCase().includes("fail")) return -50;

    // Prefer non-error EndEvents for the horizontal happy path on Track 0
    if (targetNode.$type.endsWith("EndEvent")) {
      return 100;
    }

    // If target has an immediate back-edge loop, rank lower than a process completion exit
    const hasBackEdge = (outgoingFlows.get(targetId) || []).some((f) => backEdges.has(f.id));
    if (hasBackEdge) {
      return 10;
    }

    return 50;
  }

  const spineNodeIds: string[] = [];
  const spineSet = new Set<string>();
  let curr = startEvent?.id;

  while (curr && !spineSet.has(curr)) {
    spineSet.add(curr);
    spineNodeIds.push(curr);

    const outs = (outgoingFlows.get(curr) || []).filter((f) => !backEdges.has(f.id));
    if (outs.length === 0) break;

    if (outs.length === 1) {
      curr = outs[0].targetRef?.id;
      continue;
    }

    // Multiple forward branches at gateway: pick the highest-scoring one (see
    // flowSpineScore -- an immediate error/failure exit scores low even though it
    // targets an EndEvent, so the real continuation branch still wins).
    const sortedOuts = [...outs].sort((a, b) => flowSpineScore(b, curr!) - flowSpineScore(a, curr!));
    const bestFlow = sortedOuts[0] || outs[0];
    curr = bestFlow.targetRef?.id;
  }

  // 3. Track and Column Assignment
  const nodeTrack = new Map<string, number>();
  const nodeCol = new Map<string, number>();

  // General automated track & column placement: walk the primary spine at track 0,
  // then breadth-first place every branch relative to its parent's column/track.
  let col = 0;
  for (const id of spineNodeIds) {
    nodeTrack.set(id, 0);
    nodeCol.set(id, col);
    const node = nodesById.get(id);
    const dim = getElementDimensions(node);
    const span = Math.max(1, Math.ceil(dim.width / opts.colWidth));
    col += span;
  }

  const queue = [...spineNodeIds];
  while (queue.length > 0) {
    const parentId = queue.shift()!;
    const parentCol = nodeCol.get(parentId)!;
    const parentTrack = nodeTrack.get(parentId)!;
    const parentNode = nodesById.get(parentId);
    const parentDim = getElementDimensions(parentNode);
    const parentSpan = Math.max(1, Math.ceil(parentDim.width / opts.colWidth));

    for (const flow of outgoingFlows.get(parentId) || []) {
      if (backEdges.has(flow.id)) continue;
      const targetId = flow.targetRef?.id;
      if (!targetId || !nodesById.has(targetId)) continue;

      if (!nodeTrack.has(targetId)) {
        let targetTrack = parentTrack;
        if (spineSet.has(parentId) && !spineSet.has(targetId)) {
          // Check if there is a branch spanned by a back-edge loop on the lower track
          // "session skeleton still fails to use upper gateway routes to avoid lane collision"
          const isSpannedByBackEdge = Array.from(backEdges).some((bId) => {
            const bFlow = topFlows.find((f) => f.id === bId);
            if (!bFlow) return false;
            const bSrcCol = nodeCol.get(bFlow.sourceRef?.id);
            const bTgtCol = nodeCol.get(bFlow.targetRef?.id);
            if (bSrcCol !== undefined && bTgtCol !== undefined) {
              return bTgtCol <= parentCol && parentCol <= bSrcCol;
            }
            return false;
          });

          targetTrack = isSpannedByBackEdge ? -1 : parentTrack + 1;
        }

        nodeTrack.set(targetId, targetTrack);
        const targetCol = Math.max(parentCol + parentSpan, nodeCol.get(targetId) ?? 0);
        nodeCol.set(targetId, targetCol);
        queue.push(targetId);
      } else {
        const minCol = parentCol + parentSpan;
        if (nodeCol.get(targetId)! < minCol) {
          shiftNodeAndDescendants(targetId, minCol);
        }
      }
    }
  }

  function shiftNodeAndDescendants(id: string, newCol: number) {
    const oldCol = nodeCol.get(id) || 0;
    if (newCol <= oldCol) return;
    nodeCol.set(id, newCol);
    const dim = getElementDimensions(nodesById.get(id));
    const span = Math.max(1, Math.ceil(dim.width / opts.colWidth));

    for (const flow of outgoingFlows.get(id) || []) {
      if (backEdges.has(flow.id)) continue;
      const targetId = flow.targetRef?.id;
      if (targetId && nodeCol.has(targetId)) {
        shiftNodeAndDescendants(targetId, newCol + span);
      }
    }
  }

  // Handle any orphan nodes
  let maxCol = Math.max(0, ...Array.from(nodeCol.values()));
  for (const node of topNodes) {
    if (!nodeCol.has(node.id)) {
      maxCol += 1;
      nodeCol.set(node.id, maxCol);
      nodeTrack.set(node.id, 0);
    }
  }

  // Prevent overlap on same track. Columns represent element *centers*, so compare
  // actual half-widths in column units rather than assuming each node occupies a
  // left-anchored integer span (that assumption under-reserves space for anything
  // wider than one column pitch, e.g. an expanded SubProcess).
  const tracksUsed = new Set(nodeTrack.values());
  for (const t of tracksUsed) {
    const nodesOnTrack = topNodes
      .filter((n) => nodeTrack.get(n.id) === t)
      .sort((a, b) => nodeCol.get(a.id)! - nodeCol.get(b.id)!);

    const colGap = 0.4;
    let lastRightEdge = -Infinity;
    for (const n of nodesOnTrack) {
      const dim = getElementDimensions(n);
      const halfSpan = dim.width / opts.colWidth / 2;
      let currentCol = nodeCol.get(n.id)!;
      if (currentCol - halfSpan < lastRightEdge + colGap) {
        const neededCol = Math.ceil(lastRightEdge + colGap + halfSpan);
        if (neededCol > currentCol) {
          shiftNodeAndDescendants(n.id, neededCol);
          currentCol = neededCol;
        }
      }
      lastRightEdge = currentCol + halfSpan;
    }
  }

  // Horizontally align terminal end events across different tracks when unobstructed
  // "end events should be horizontally aligned when it does not cause additional node or lane collisions."
  const endEvents = topNodes.filter((n) => n.$type.endsWith("EndEvent"));
  if (endEvents.length > 1) {
    const maxEndCol = Math.max(...endEvents.map((n) => nodeCol.get(n.id) ?? 0));
    for (const endNode of endEvents) {
      const currentCol = nodeCol.get(endNode.id) ?? 0;
      if (currentCol < maxEndCol) {
        const track = nodeTrack.get(endNode.id) ?? 0;
        const hasObstacle = topNodes.some(
          (n) => n.id !== endNode.id && nodeTrack.get(n.id) === track && (nodeCol.get(n.id) ?? 0) >= currentCol && (nodeCol.get(n.id) ?? 0) <= maxEndCol,
        );
        if (!hasObstacle) {
          nodeCol.set(endNode.id, maxEndCol);
        }
      }
    }
  }

  // 4. Compute Coordinates for Top-Level Nodes and Nested SubProcesses
  const layoutNodes = new Map<string, NodeLayout>();

  const minTrack = Math.min(0, ...Array.from(nodeTrack.values()));
  const spineTrack = minTrack === -1 ? -1 : 0;

  // The default track pitch (opts.trackGap) assumes ~80px-tall elements. A track
  // holding something taller (e.g. an expanded SubProcess) needs extra clearance so
  // it doesn't bleed into a neighboring track's band -- compute that once per track
  // from actual element sizes instead of assuming a fixed height everywhere.
  function maxHeightOnTrack(trackVal: number): number {
    let max = 80;
    for (const n of topNodes) {
      if (nodeTrack.get(n.id) === trackVal) max = Math.max(max, getElementDimensions(n).height);
    }
    return max;
  }
  const distinctTracks = Array.from(new Set(nodeTrack.values())).sort((a, b) => a - b);
  const extraClearanceForTrack = new Map<number, number>([[spineTrack, 0]]);
  let cumExtra = 0;
  let prevTrack = spineTrack;
  for (const trackVal of distinctTracks.filter((tv) => tv > spineTrack)) {
    cumExtra += Math.max(0, maxHeightOnTrack(prevTrack) - 80) / 2 + Math.max(0, maxHeightOnTrack(trackVal) - 80) / 2;
    extraClearanceForTrack.set(trackVal, cumExtra);
    prevTrack = trackVal;
  }

  for (const node of topNodes) {
    const c = nodeCol.get(node.id)!;
    const t = nodeTrack.get(node.id)!;
    const dim = getElementDimensions(node);

    const centerX = 75 + c * opts.colWidth;
    let centerY = opts.spineY;

    if (minTrack === -1) {
      if (t === -1) centerY = opts.spineY;
      else if (t === 0) centerY = opts.spineY + opts.trackGap;
      else if (t === 1) centerY = opts.spineY + 2 * opts.trackGap;
      else if (t > 1) centerY = opts.spineY + (t + 1) * opts.trackGap;
    } else {
      if (t === 1) centerY = opts.track1Y;
      else if (t === 2) centerY = opts.track2Y;
      else if (t > 2) centerY = opts.track2Y + (t - 2) * opts.trackGap;
    }
    centerY += extraClearanceForTrack.get(t) ?? 0;

    let x = centerX - dim.width / 2;
    let y = centerY - dim.height / 2;

    if (node.$type === "bpmn:SubProcess") {
      // Expanded subprocess positioning and child elements. x/y/centerY above are
      // already derived from this node's track using its own (360x200) dimensions --
      // keep them, just lay out children relative to that box.
      const childElements: any[] = node.flowElements || [];
      const childNodes = childElements.filter((el) => el.$type !== "bpmn:SequenceFlow");

      // Lay out child nodes internally with clean, compact padding
      // "expandes subprocess has huge horizontal padding"
      let childX = x + 35;
      for (const child of childNodes) {
        const cdim = getElementDimensions(child);
        const childY = centerY - cdim.height / 2;
        layoutNodes.set(child.id, {
          id: child.id,
          element: child,
          col: 0,
          track: t,
          x: childX,
          y: childY,
          width: cdim.width,
          height: cdim.height,
          centerX: childX + cdim.width / 2,
          centerY,
          isSubProcessChild: true,
        });
        childX += cdim.width + 60;
      }
    }

    layoutNodes.set(node.id, {
      id: node.id,
      element: node,
      col: c,
      track: t,
      x,
      y,
      width: dim.width,
      height: dim.height,
      centerX,
      centerY,
    });
  }

  // Collect all flows including child subprocess flows
  const allFlows: any[] = [...topFlows];
  for (const node of topNodes) {
    if (node.$type === "bpmn:SubProcess") {
      allFlows.push(...(node.flowElements || []).filter((el: any) => el.$type === "bpmn:SequenceFlow"));
    }
  }

  return { nodes: layoutNodes, allFlows };
}

interface LabelBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

function estimateTextLines(text: string, width: number): number {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 1;
  let lines = 1;
  let currentLineWidth = 0;
  const avgCharWidth = 6.8;
  const spaceWidth = 4;

  for (const word of words) {
    const wordWidth = word.length * avgCharWidth;
    if (currentLineWidth === 0) {
      currentLineWidth = wordWidth;
    } else if (currentLineWidth + spaceWidth + wordWidth <= width) {
      currentLineWidth += spaceWidth + wordWidth;
    } else {
      lines += 1;
      currentLineWidth = wordWidth;
    }
  }
  return lines;
}

function formatTextForLines(text: string, width: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= 1) return text;
  let currentLineWidth = 0;
  const avgCharWidth = 6.8;
  const spaceWidth = 4;
  const lines: string[][] = [[]];

  for (const word of words) {
    const wordWidth = word.length * avgCharWidth;
    if (lines[lines.length - 1]!.length === 0) {
      lines[lines.length - 1]!.push(word);
      currentLineWidth = wordWidth;
    } else if (currentLineWidth + spaceWidth + wordWidth <= width) {
      lines[lines.length - 1]!.push(word);
      currentLineWidth += spaceWidth + wordWidth;
    } else {
      lines.push([word]);
      currentLineWidth = wordWidth;
    }
  }
  return lines.map((l) => l.join(" ")).join("\n");
}

function getCandidateWidthsForNode(name: string, isGateway: boolean): number[] {
  const clean = name.replace(/\s+/g, " ").trim();
  const words = clean.split(" ");
  if (!isGateway) {
    const initialLines = estimateTextLines(clean, 90);
    return initialLines >= 2 ? [90, 105, 120, 80] : [90];
  }

  // Short single word / short label (<= 9 chars): natural single line
  if (words.length <= 1 || clean.length <= 9) {
    const tightW = Math.max(30, Math.round(clean.length * 6.8) + 8);
    return [tightW, 60, 80];
  }

  // Multi-word gateway label:
  // "Also long single line labels could be narrowed to flow in two lines."
  // "If label is rendered on three lines, it should be made wider to make it fit on two lines."
  const twoLineWidths: number[] = [];
  for (let w = 40; w <= 140; w += 2) {
    const lines = estimateTextLines(clean, w);
    if (lines === 2) {
      twoLineWidths.push(w);
    }
  }

  if (twoLineWidths.length > 0) {
    const min2LineW = twoLineWidths[0]!;
    const median2LineW = twoLineWidths[Math.floor(twoLineWidths.length / 2)]!;
    const max2LineW = twoLineWidths[twoLineWidths.length - 1]!;
    return Array.from(new Set([min2LineW, median2LineW, max2LineW, 70, 80]));
  }

  // If 3+ lines even at 140, widen until it fits 2 lines
  for (let w = 150; w <= 240; w += 10) {
    if (estimateTextLines(clean, w) <= 2) {
      return [w, w + 10];
    }
  }

  return [90, 105, 120];
}

function segmentIntersectsBox(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  bx: number,
  by: number,
  bw: number,
  bh: number,
  margin = 4,
): boolean {
  const minX = bx - margin;
  const maxX = bx + bw + margin;
  const minY = by - margin;
  const maxY = by + bh + margin;

  if (x1 >= minX && x1 <= maxX && y1 >= minY && y1 <= maxY) return true;
  if (x2 >= minX && x2 <= maxX && y2 >= minY && y2 <= maxY) return true;

  const dx = x2 - x1;
  const dy = y2 - y1;

  let tEnter = 0;
  let tExit = 1;

  if (dx === 0) {
    if (x1 < minX || x1 > maxX) return false;
  } else {
    const t1 = (minX - x1) / dx;
    const t2 = (maxX - x1) / dx;
    tEnter = Math.max(tEnter, Math.min(t1, t2));
    tExit = Math.min(tExit, Math.max(t1, t2));
    if (tEnter > tExit) return false;
  }

  if (dy === 0) {
    if (y1 < minY || y1 > maxY) return false;
  } else {
    const t1 = (minY - y1) / dy;
    const t2 = (maxY - y1) / dy;
    tEnter = Math.max(tEnter, Math.min(t1, t2));
    tExit = Math.min(tExit, Math.max(t1, t2));
    if (tEnter > tExit) return false;
  }

  return tEnter <= tExit;
}

function labelCollidesWithLanes(
  bounds: LabelBounds,
  edgeWaypoints: Map<string, Array<{ x: number; y: number }>>,
  margin = 4,
): boolean {
  for (const pts of edgeWaypoints.values()) {
    for (let i = 0; i < pts.length - 1; i += 1) {
      const p1 = pts[i];
      const p2 = pts[i + 1];
      if (p1 && p2 && segmentIntersectsBox(p1.x, p1.y, p2.x, p2.y, bounds.x, bounds.y, bounds.width, bounds.height, margin)) {
        return true;
      }
    }
  }
  return false;
}

function labelCollidesWithElements(
  bounds: LabelBounds,
  targetId: string,
  nodes: Map<string, NodeLayout>,
): boolean {
  for (const node of nodes.values()) {
    if (node.id === targetId || node.isSubProcessChild) continue;
    if (node.element.$type === "bpmn:SubProcess") continue;
    if (
      bounds.x < node.x + node.width &&
      node.x < bounds.x + bounds.width &&
      bounds.y < node.y + node.height &&
      node.y < bounds.y + bounds.height
    ) {
      return true;
    }
  }
  return false;
}

function labelCollidesWithOtherLabels(
  bounds: LabelBounds,
  placedLabels: LabelBounds[],
): boolean {
  for (const other of placedLabels) {
    if (
      bounds.x < other.x + other.width &&
      other.x < bounds.x + bounds.width &&
      bounds.y < other.y + other.height &&
      other.y < bounds.y + bounds.height
    ) {
      return true;
    }
  }
  return false;
}

function solveLabelPlacement(
  node: NodeLayout,
  edgeWaypoints: Map<string, Array<{ x: number; y: number }>>,
  nodes: Map<string, NodeLayout>,
  placedLabels: LabelBounds[],
): LabelBounds {
  const name = node.element.name || "";
  const isGateway = node.element.$type.endsWith("Gateway");

  // Determine flow attachments for gateways
  let hasTopFlow = false;
  let hasBottomFlow = false;
  let hasLeftFlow = false;
  let hasRightFlow = false;
  for (const [flowId, pts] of edgeWaypoints.entries()) {
    if (!pts || pts.length === 0) continue;
    const flow = (node.element.incoming || []).concat(node.element.outgoing || []).find((f: any) => f.id === flowId);
    if (!flow) continue;

    const startPt = pts[0];
    const endPt = pts[pts.length - 1];
    if (flow.sourceRef?.id === node.id && startPt) {
      if (startPt.y < node.centerY - 5) hasTopFlow = true;
      else if (startPt.y > node.centerY + 5) hasBottomFlow = true;
      else if (startPt.x < node.centerX - 5) hasLeftFlow = true;
      else if (startPt.x > node.centerX + 5) hasRightFlow = true;
    }
    if (flow.targetRef?.id === node.id && endPt) {
      if (endPt.y < node.centerY - 5) hasTopFlow = true;
      else if (endPt.y > node.centerY + 5) hasBottomFlow = true;
      else if (endPt.x < node.centerX - 5) hasLeftFlow = true;
      else if (endPt.x > node.centerX + 5) hasRightFlow = true;
    }
  }

  // Determine preferred primary orientation (top vs bottom)
  let preferredTop = false;
  if (isGateway) {
    if (hasBottomFlow && !hasTopFlow) preferredTop = true;
  }

  // Check if text is multiple lines at standard width 90
  const initialLines = estimateTextLines(name, 90);

  const isFourDirectionGateway = isGateway && hasTopFlow && hasBottomFlow && hasLeftFlow && hasRightFlow;
  const isLeftFreeGateway = isGateway && hasTopFlow && hasBottomFlow && !hasLeftFlow;
  const isRightFreeGateway = isGateway && hasTopFlow && hasBottomFlow && !hasRightFlow;

  // Candidate widths:
  // "Also long single line labels could be narrowed to flow in two lines."
  // "If label is rendered on three lines, it should be made wider to make it fit on two lines."
  const candidateWidths = getCandidateWidthsForNode(name, isGateway);

  const candidates: Array<LabelBounds & { lines: number }> = [];

  for (const W of candidateWidths) {
    const formatted = formatTextForLines(name, W);
    const lineArray = formatted.split("\n");
    const lines = lineArray.length;
    let maxLineChars = 0;
    for (const l of lineArray) {
      if (l.length > maxLineChars) maxLineChars = l.length;
    }
    const tightW = isGateway ? Math.max(30, Math.min(W, Math.round(maxLineChars * 6.8) + 8)) : W;
    const H = lines === 1 ? (isGateway ? 14 : 20) : (lines === 2 ? 27 : lines * 14);
    const gap = isGateway && lines === 1 ? 2 : 8;

    const primaryY = preferredTop ? Math.round(node.y - H - gap) : Math.round(node.y + node.height + gap);
    const altY = preferredTop ? Math.round(node.y + node.height + gap) : Math.round(node.y - H - gap);

    if (isFourDirectionGateway) {
      // 1. Snug top-left diagonal preferred in 4-direction gateway
      // "Diagonally or horizontally placed gateway labels still feel like being too far from the gateway."
      candidates.push({ x: Math.round(node.centerX - tightW - 2), y: Math.round(node.y - H + 2), width: tightW, height: H, lines });
      // Other snug diagonals as fallbacks
      candidates.push({ x: Math.round(node.centerX + 2), y: Math.round(node.y - H + 2), width: tightW, height: H, lines });
      candidates.push({ x: Math.round(node.centerX - tightW - 2), y: Math.round(node.y + node.height - 2), width: tightW, height: H, lines });
      candidates.push({ x: Math.round(node.centerX + 2), y: Math.round(node.y + node.height - 2), width: tightW, height: H, lines });
    } else if (isLeftFreeGateway) {
      // "Horizontally placed label should be vertically aligned with gateway center."
      // "Diagonally or horizontally placed gateway labels still feel like being too far from the gateway."
      candidates.push({ x: Math.round(node.x - tightW - 2), y: Math.round(node.centerY - H / 2), width: tightW, height: H, lines });
      // Snug top-left diagonal as fallback
      candidates.push({ x: Math.round(node.centerX - tightW - 2), y: Math.round(node.y - H + 2), width: tightW, height: H, lines });
    } else if (isRightFreeGateway) {
      candidates.push({ x: Math.round(node.x + node.width + 2), y: Math.round(node.centerY - H / 2), width: tightW, height: H, lines });
      candidates.push({ x: Math.round(node.centerX + 2), y: Math.round(node.y - H + 2), width: tightW, height: H, lines });
    } else {
      // 1. Primary side centered
      candidates.push({ x: Math.round(node.centerX - tightW / 2), y: primaryY, width: tightW, height: H, lines });

      // 2. Primary side shifted left / right
      for (const dx of [20, -20, 40, -40, 60, -60]) {
        candidates.push({ x: Math.round(node.centerX - tightW / 2 + dx), y: primaryY, width: tightW, height: H, lines });
      }

      // 3. Alternate side centered + shifted left / right
      candidates.push({ x: Math.round(node.centerX - tightW / 2), y: altY, width: tightW, height: H, lines });
      for (const dx of [20, -20, 40, -40]) {
        candidates.push({ x: Math.round(node.centerX - tightW / 2 + dx), y: altY, width: tightW, height: H, lines });
      }

      // 4. Snug diagonal positions
      candidates.push({ x: Math.round(node.centerX - tightW - 2), y: Math.round(node.y - H + 2), width: tightW, height: H, lines });
      candidates.push({ x: Math.round(node.centerX + 2), y: Math.round(node.y - H + 2), width: tightW, height: H, lines });
      candidates.push({ x: Math.round(node.centerX - tightW - 2), y: Math.round(node.y + node.height - 2), width: tightW, height: H, lines });
      candidates.push({ x: Math.round(node.centerX + 2), y: Math.round(node.y + node.height - 2), width: tightW, height: H, lines });

      // 5. Snug horizontal positions
      candidates.push({ x: Math.round(node.x - tightW - 2), y: Math.round(node.centerY - H / 2), width: tightW, height: H, lines });
      candidates.push({ x: Math.round(node.x + node.width + 2), y: Math.round(node.centerY - H / 2), width: tightW, height: H, lines });
    }
  }

  // Find the first candidate that collides with neither lanes, elements, nor other labels
  let chosen: (LabelBounds & { lines: number }) | null = null;
  for (const cand of candidates) {
    if (cand.x < 10 || cand.y < 0) continue;
    if (labelCollidesWithLanes(cand, edgeWaypoints)) continue;
    if (labelCollidesWithElements(cand, node.id, nodes)) continue;
    if (labelCollidesWithOtherLabels(cand, placedLabels)) continue;
    chosen = cand;
    break;
  }

  // Fallback: candidate that does not collide with elements or labels even if it touches a lane
  if (!chosen) {
    for (const cand of candidates) {
      if (cand.x < 10 || cand.y < 0) continue;
      if (labelCollidesWithElements(cand, node.id, nodes)) continue;
      if (labelCollidesWithOtherLabels(cand, placedLabels)) continue;
      chosen = cand;
      break;
    }
  }

  if (!chosen) {
    const defaultW = 90;
    const defaultLines = estimateTextLines(name, defaultW);
    const defaultH = defaultLines === 1 ? (isGateway ? 14 : 20) : (defaultLines === 2 ? 27 : defaultLines * 14);
    const defaultGap = isGateway && defaultLines === 1 ? 2 : 8;
    const defaultY = preferredTop
      ? Math.round(node.y - defaultH - defaultGap)
      : Math.round(node.y + node.height + defaultGap);
    chosen = {
      x: Math.round(node.centerX - defaultW / 2),
      y: defaultY,
      width: defaultW,
      height: defaultH,
      lines: defaultLines,
    };
  }

  return {
    x: chosen.x,
    y: chosen.y,
    width: chosen.width,
    height: chosen.height,
  };
}

function shouldUseUpsideRoute(
  src: NodeLayout,
  tgt: NodeLayout,
  layout: ProcessLayoutResult,
  flowId?: string,
): boolean {
  if (!src.element.$type.endsWith("Gateway") || !tgt.element.$type.endsWith("Gateway")) {
    return false;
  }

  // Both gateways must be on the same track (typically Track 0)
  if (src.track !== tgt.track) {
    return false;
  }

  // Check if there are nodes on upper tracks that would block the upside route
  const minTrack = Math.min(0, ...Array.from(layout.nodes.values()).map((n) => n.track));
  const minCol = Math.min(src.col, tgt.col);
  const maxCol = Math.max(src.col, tgt.col);
  if (minTrack < 0) {
    const hasUpperObstacle = Array.from(layout.nodes.values()).some(
      (n) => n.track < 0 && n.col >= minCol && n.col <= maxCol,
    );
    if (hasUpperObstacle) return false;
  }

  // Intermediate nodes along the track (must skip intermediate nodes)
  const intermediateNodes = Array.from(layout.nodes.values()).filter(
    (n) => n.id !== src.id && n.id !== tgt.id && n.track === src.track && n.col > minCol && n.col < maxCol,
  );
  if (intermediateNodes.length === 0) {
    return false;
  }

  // Check other incoming flows to tgt on the same track
  const otherIncomingSameTrack = layout.allFlows.filter((f) => {
    if (f.id === flowId || f.targetRef?.id !== tgt.id) return false;
    const fSrc = layout.nodes.get(f.sourceRef?.id);
    return fSrc && fSrc.track === tgt.track && fSrc.id !== src.id;
  });

  // If multiple bypass flows on the same track target tgt, only the longest span takes the upside route
  const currentSpan = Math.abs(src.col - tgt.col);
  const isLongerThanOtherBypasses = otherIncomingSameTrack.every((f) => {
    const fSrc = layout.nodes.get(f.sourceRef?.id)!;
    const otherSpan = Math.abs(fSrc.col - tgt.col);
    return currentSpan > otherSpan;
  });

  if (!isLongerThanOtherBypasses) {
    return false;
  }

  // If this flow is a loop-back (tgt.col <= src.col) but src also has a forward bypass,
  // let the forward bypass take the upside route while this loop-back takes the bottom route
  if (tgt.col <= src.col) {
    const hasForwardBypass = layout.allFlows.some((f) => {
      if (f.id === flowId || f.sourceRef?.id !== src.id) return false;
      const fTgt = layout.nodes.get(f.targetRef?.id);
      return fTgt && fTgt.track === src.track && fTgt.col > src.col + 1;
    });
    if (hasForwardBypass) return false;
  }

  // Check if src already has another outgoing flow that uses the bottom vertex
  const otherOutgoing = layout.allFlows.filter((f) => f.id !== flowId && f.sourceRef?.id === src.id);
  const srcHasBottomOutgoing = otherOutgoing.some((f) => {
    const fTgt = layout.nodes.get(f.targetRef?.id);
    if (!fTgt) return false;
    return fTgt.col <= src.col || fTgt.track > src.track;
  });

  // Check if tgt already has another incoming flow that uses the bottom vertex
  const otherIncoming = layout.allFlows.filter((f) => f.id !== flowId && f.targetRef?.id === tgt.id);
  const tgtHasBottomIncoming = otherIncoming.some((f) => {
    const fSrc = layout.nodes.get(f.sourceRef?.id);
    if (!fSrc) return false;
    return tgt.col <= fSrc.col || fSrc.track > tgt.track;
  });

  // Check if tgt has an outgoing flow that uses the bottom vertex (e.g. branch to lower track)
  const tgtOutgoing = layout.allFlows.filter((f) => f.sourceRef?.id === tgt.id);
  const tgtHasBottomOutgoing = tgtOutgoing.some((f) => {
    const fTgt = layout.nodes.get(f.targetRef?.id);
    if (!fTgt) return false;
    return fTgt.col <= tgt.col || fTgt.track > tgt.track;
  });

  if (srcHasBottomOutgoing || tgtHasBottomIncoming || tgtHasBottomOutgoing || otherIncoming.length > 0) {
    return true;
  }

  return false;
}

/**
 * A sequence flow's own label. Candidates are filtered against other labels
 * *and* against the elements themselves: checking only labels is how
 * `pi-default-loop.bpmn`'s "hit token limit" ended up printed across
 * `gw_truncated` and `fail_tool_batch`, since neither of those carries a label
 * of its own at that spot.
 */
/**
 * The first candidate that clears every element and every label already
 * placed; failing that, whichever overlaps least, so a crowded diagram
 * degrades to "slightly close" rather than "printed on top of a task".
 */
function pickLabel(
  candidates: LabelBounds[],
  fallback: LabelBounds,
  flow: any,
  placedLabels: LabelBounds[],
  nodes: Map<string, NodeLayout>,
  edgeWaypoints: Map<string, Array<{ x: number; y: number }>> = new Map(),
): LabelBounds {
  // A line drawn through the text is as unreadable as a box behind it, but a
  // label *near* a line is normal, so this is weighted below a real overlap
  // rather than treated as disqualifying.
  const crossedByEdge = (bounds: LabelBounds): number => {
    let crossings = 0;
    for (const [flowId, pts] of edgeWaypoints) {
      if (flowId === flow?.id) continue;
      for (let i = 0; i < pts.length - 1; i += 1) {
        const a = pts[i]!;
        const b = pts[i + 1]!;
        if (Math.abs(a.y - b.y) < 0.5) {
          if (a.y <= bounds.y || a.y >= bounds.y + bounds.height) continue;
          if (Math.max(Math.min(a.x, b.x), bounds.x) < Math.min(Math.max(a.x, b.x), bounds.x + bounds.width)) {
            crossings += 1;
          }
        } else if (Math.abs(a.x - b.x) < 0.5) {
          if (a.x <= bounds.x || a.x >= bounds.x + bounds.width) continue;
          if (Math.max(Math.min(a.y, b.y), bounds.y) < Math.min(Math.max(a.y, b.y), bounds.y + bounds.height)) {
            crossings += 1;
          }
        }
      }
    }
    return crossings;
  };
  const overlapArea = (bounds: LabelBounds): number => {
    let area = 0;
    for (const node of nodes.values()) {
      if (node.isSubProcessChild || node.element?.$type === "bpmn:SubProcess") continue;
      const overlap = boxOverlap(bounds, node);
      const isOwnEndpoint = node.id === flow?.sourceRef?.id || node.id === flow?.targetRef?.id;
      const rendersNameOutside =
        node.element?.$type?.endsWith("Event") || node.element?.$type?.endsWith("Gateway");
      if (isOwnEndpoint && rendersNameOutside && overlap < 100) {
        // Clipping the corner of its own gateway or event is the usual case for
        // a short stub, and those render their own name outside the shape.
        area += 0.1 * overlap;
        continue;
      }
      area += overlap;
      continue;
    }
    for (const other of placedLabels) area += boxOverlap(bounds, other);
    return area + crossedByEdge(bounds) * 120;
  };

  let best = fallback;
  let bestArea = overlapArea(fallback);
  for (const cand of candidates) {
    if (cand.x < 0 || cand.y < 0) continue;
    const area = overlapArea(cand);
    if (area === 0) return cand;
    if (area < bestArea) {
      best = cand;
      bestArea = area;
    }
  }
  return best;
}

function boxOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function computeEdgeLabelBounds(
  flow: any,
  waypoints: Array<{ x: number; y: number }>,
  edgeWaypoints: Map<string, Array<{ x: number; y: number }>>,
  placedLabels: LabelBounds[] = [],
  nodes: Map<string, NodeLayout> = new Map(),
): LabelBounds | null {
  if (!flow.name || typeof flow.name !== "string" || flow.name.trim().length === 0) {
    return null;
  }
  const text = flow.name.trim();

  // Find candidate segments
  let bestSeg: { p1: { x: number; y: number }; p2: { x: number; y: number }; isHoriz: boolean; len: number } | null = null;

  for (let i = 0; i < waypoints.length - 1; i++) {
    const p1 = waypoints[i];
    const p2 = waypoints[i + 1];
    if (!p1 || !p2) continue;
    const isHoriz = p1.y === p2.y;
    const isVert = p1.x === p2.x;
    const len = isHoriz ? Math.abs(p2.x - p1.x) : (isVert ? Math.abs(p2.y - p1.y) : 0);

    // Prefer horizontal segment with length >= 30
    if (isHoriz && len >= 30) {
      if (!bestSeg || !bestSeg.isHoriz || len > bestSeg.len) {
        bestSeg = { p1, p2, isHoriz: true, len };
      }
    } else if (!bestSeg && len >= 20) {
      bestSeg = { p1, p2, isHoriz: false, len };
    }
  }

  if (!bestSeg) return null;

  const width = Math.min(90, Math.max(30, Math.round(text.length * 6.5) + 10));
  const height = 14;

  if (bestSeg.isHoriz) {
    const minX = Math.min(bestSeg.p1.x, bestSeg.p2.x);
    const maxX = Math.max(bestSeg.p1.x, bestSeg.p2.x);
    const midX = (minX + maxX) / 2;

    // Check if there is another flow running above this segment or if segment is at or above Y=0
    // "ok" lane is pretty close to "another turn" lane, maybe label could have been on the bottom side of lane
    const hasFlowAbove = bestSeg.p1.y <= 0 || Array.from(edgeWaypoints.values()).some((pts) => {
      for (let j = 0; j < pts.length - 1; j++) {
        const q1 = pts[j];
        const q2 = pts[j + 1];
        if (!q1 || !q2) continue;
        if (q1.y === q2.y && q1.y < bestSeg!.p1.y && bestSeg!.p1.y - q1.y <= 40) {
          const qMinX = Math.min(q1.x, q2.x);
          const qMaxX = Math.max(q1.x, q2.x);
          if (Math.max(minX, qMinX) < Math.min(maxX, qMaxX)) return true;
        }
      }
      return false;
    });

    const primaryY = hasFlowAbove ? Math.round(bestSeg.p1.y + 4) : Math.round(bestSeg.p1.y - height - 2);
    const altY = hasFlowAbove ? Math.round(bestSeg.p1.y - height - 2) : Math.round(bestSeg.p1.y + 4);
    const centeredX = Math.round(midX - width / 2);

    // A short stub between two elements has no room on either side of the line
    // -- the line runs through their middles, so "just above the segment" is
    // still inside them. Offer the clear band above and below whatever the
    // segment passes between as well.
    const straddled = Array.from(nodes.values()).filter(
      (n) =>
        !n.isSubProcessChild &&
        n.element?.$type !== "bpmn:SubProcess" &&
        // The label is centred on the segment and wider than a short stub, so
        // the elements it can foul are the ones at either end too, not only
        // those strictly inside the segment's own span.
        n.x <= maxX + width / 2 &&
        minX - width / 2 <= n.x + n.width &&
        n.y < bestSeg!.p1.y + height &&
        bestSeg!.p1.y - height < n.y + n.height,
    );
    const clearAbove = straddled.length ? Math.min(...straddled.map((n) => n.y)) - height - 4 : primaryY;
    const clearBelow = straddled.length ? Math.max(...straddled.map((n) => n.y + n.height)) + 4 : altY;

    const candidates: LabelBounds[] = [];
    for (const y of [primaryY, altY, clearAbove, clearBelow]) {
      for (const dx of [0, 20, -20, 40, -40, 60, -60, 80, -80]) {
        const x = centeredX + dx;
        // Keep the label over its own segment rather than sliding off the end
        // of it, where it would read as belonging to a different edge -- with a
        // little slack, since a stub between two adjacent elements is shorter
        // than the text and would otherwise have exactly one candidate per row.
        if (x + width / 2 < minX - LABEL_SLIDE_SLACK || x + width / 2 > maxX + LABEL_SLIDE_SLACK) continue;
        candidates.push({ x, y, width, height });
      }
    }
    return pickLabel(candidates, { x: centeredX, y: primaryY, width, height }, flow, placedLabels, nodes, edgeWaypoints);
  } else {
    // Vertical segment: sit 4px to the right of the vertical line, or to the left
    // if that collides with an already-placed label.
    const minY = Math.min(bestSeg.p1.y, bestSeg.p2.y);
    const maxY = Math.max(bestSeg.p1.y, bestSeg.p2.y);
    const midY = (minY + maxY) / 2;
    const y = Math.round(midY - height / 2);
    const rightX = Math.round(bestSeg.p1.x + 4);
    const leftX = Math.round(bestSeg.p1.x - width - 4);

    const candidates: LabelBounds[] = [];
    for (const dy of [0, -18, 18, -36, 36]) {
      candidates.push({ x: rightX, y: y + dy, width, height });
      candidates.push({ x: leftX, y: y + dy, width, height });
    }
    return pickLabel(candidates, { x: rightX, y, width, height }, flow, placedLabels, nodes, edgeWaypoints);
  }
}

/**
 * Every edge attaches at the middle of a node's side, so two edges that use the
 * same side run down the same line -- in `pi-default-loop.bpmn` the flow into
 * `gw_followup` and the flow back out of it shared 285px of it, which draws as
 * one edge. Spread the attach points of each crowded side across that side, and
 * move the neighbouring waypoint with them so the polyline stays orthogonal.
 */
function fanOutAttachPoints(
  edgeWaypoints: Map<string, Array<{ x: number; y: number }>>,
  layout: ProcessLayoutResult,
): void {
  interface Attach {
    flowId: string;
    index: number;
  }
  const bySide = new Map<string, Attach[]>();

  for (const flow of layout.allFlows) {
    const pts = edgeWaypoints.get(flow.id);
    if (!pts || pts.length < 2) continue;
    for (const [index, nodeId] of [
      [0, flow.sourceRef?.id],
      [pts.length - 1, flow.targetRef?.id],
    ] as Array<[number, string]>) {
      const node = layout.nodes.get(nodeId);
      const p = pts[index];
      if (!node || !p) continue;
      let side: string | null = null;
      if (Math.abs(p.y - node.y) < 0.5) side = "top";
      else if (Math.abs(p.y - (node.y + node.height)) < 0.5) side = "bottom";
      else if (Math.abs(p.x - node.x) < 0.5) side = "left";
      else if (Math.abs(p.x - (node.x + node.width)) < 0.5) side = "right";
      if (!side) continue;
      const key = `${nodeId}:${side}`;
      (bySide.get(key) ?? bySide.set(key, []).get(key)!).push({ flowId: flow.id, index });
    }
  }

  for (const [key, attaches] of bySide) {
    if (attaches.length < 2) continue;
    const [nodeId, side] = key.split(":") as [string, string];
    const node = layout.nodes.get(nodeId);
    if (!node) continue;
    const horizontalSide = side === "top" || side === "bottom";
    const extent = horizontalSide ? node.width : node.height;
    // Keep the fan inside the middle half of the side, so an attach point never
    // lands on a corner.
    const step = extent / 2 / (attaches.length + 1);
    const start = (horizontalSide ? node.x : node.y) + extent / 4 + step;
    attaches.sort((a, b) => a.flowId.localeCompare(b.flowId));
    attaches.forEach((attach, i) => {
      const pts = edgeWaypoints.get(attach.flowId)!;
      const coord = start + i * step;
      const neighbour = attach.index === 0 ? pts[1] : pts[pts.length - 2];
      const point = pts[attach.index]!;
      if (horizontalSide) {
        if (neighbour && Math.abs(neighbour.x - point.x) < 0.5) neighbour.x = coord;
        point.x = coord;
      } else {
        if (neighbour && Math.abs(neighbour.y - point.y) < 0.5) neighbour.y = coord;
        point.y = coord;
      }
    });
  }
}

function createProcessDi(
  moddle: any,
  rootElement: any,
  process: any,
  layout: ProcessLayoutResult,
  opts: Required<AutoLayoutOptions>,
) {
  const planeElements: any[] = [];

  // 1. Precompute Edge DI waypoints for each sequence flow.
  //
  // Twice: the first pass lets `computeWaypoints` declare which flows route
  // through a channel and how far each spans, the second reads back the lane
  // the planner gave it. See `planChannels`.
  const edgeWaypoints = new Map<string, Array<{ x: number; y: number }>>();
  const { recorder, resolve } = planChannels(layout.nodes);
  for (const pass of [recorder, null]) {
    layout.channels = pass ?? resolve();
    edgeWaypoints.clear();
    for (const flow of layout.allFlows) {
      const src = layout.nodes.get(flow.sourceRef?.id);
      const tgt = layout.nodes.get(flow.targetRef?.id);
      if (!src || !tgt) continue;
      edgeWaypoints.set(flow.id, repairSegmentCollisions(computeWaypoints(src, tgt, layout, opts, flow), layout, flow));
    }
  }
  fanOutAttachPoints(edgeWaypoints, layout);

  const placedLabels: LabelBounds[] = [];

  // 1.5 Precompute edge labels first and reserve their space, so node label
  // placement (which already avoids other placed labels) also avoids edge labels
  // instead of only ever avoiding other node labels.
  const edgeLabelBounds = new Map<string, LabelBounds>();
  for (const flow of layout.allFlows) {
    const waypoints = edgeWaypoints.get(flow.id);
    if (!waypoints) continue;
    const edgeLabel = computeEdgeLabelBounds(flow, waypoints, edgeWaypoints, placedLabels, layout.nodes);
    if (edgeLabel) {
      edgeLabelBounds.set(flow.id, edgeLabel);
      placedLabels.push(edgeLabel);
    }
  }

  // 2. Create Shape DI for each node with collision-free labels
  for (const [id, node] of layout.nodes.entries()) {
    const isMarkerVisible = node.element.$type.endsWith("Gateway") ? true : undefined;
    const isExpanded = node.element.$type === "bpmn:SubProcess" ? true : undefined;

    const shapeAttrs: any = {
      id: `${id}_di`,
      bpmnElement: node.element,
      bounds: moddle.create("dc:Bounds", {
        x: Math.round(node.x),
        y: Math.round(node.y),
        width: Math.round(node.width),
        height: Math.round(node.height),
      }),
    };
    if (isMarkerVisible !== undefined) shapeAttrs.isMarkerVisible = isMarkerVisible;
    if (isExpanded !== undefined) shapeAttrs.isExpanded = isExpanded;

    // External label for Events and Gateways with visible name
    const hasName = typeof node.element.name === "string" && node.element.name.trim().length > 0;
    const needsLabel = (node.element.$type.endsWith("Event") || node.element.$type.endsWith("Gateway")) && hasName;

    if (needsLabel) {
      const labelBounds = solveLabelPlacement(node, edgeWaypoints, layout.nodes, placedLabels);
      placedLabels.push(labelBounds);

      shapeAttrs.label = moddle.create("bpmndi:BPMNLabel", {
        bounds: moddle.create("dc:Bounds", {
          x: labelBounds.x,
          y: labelBounds.y,
          width: labelBounds.width,
          height: labelBounds.height,
        }),
      });
    }

    planeElements.push(moddle.create("bpmndi:BPMNShape", shapeAttrs));
  }

  // 3. Create Edge DI for each sequence flow
  for (const flow of layout.allFlows) {
    const waypoints = edgeWaypoints.get(flow.id);
    if (!waypoints) continue;

    const edgeDiAttrs: any = {
      id: `${flow.id}_di`,
      bpmnElement: flow,
      waypoint: waypoints.map((pt) =>
        moddle.create("dc:Point", {
          x: Math.round(pt.x),
          y: Math.round(pt.y),
        }),
      ),
    };

    const edgeLabel = edgeLabelBounds.get(flow.id);
    if (edgeLabel) {
      edgeDiAttrs.label = moddle.create("bpmndi:BPMNLabel", {
        bounds: moddle.create("dc:Bounds", {
          x: edgeLabel.x,
          y: edgeLabel.y,
          width: edgeLabel.width,
          height: edgeLabel.height,
        }),
      });
    }

    const edgeDi = moddle.create("bpmndi:BPMNEdge", edgeDiAttrs);
    planeElements.push(edgeDi);
  }

  const plane = moddle.create("bpmndi:BPMNPlane", {
    id: `BPMNPlane_${process.id}`,
    bpmnElement: process,
    planeElement: planeElements,
  });

  const diagram = moddle.create("bpmndi:BPMNDiagram", {
    id: `BPMNDiagram_${process.id}`,
    plane,
  });

  rootElement.diagrams.push(diagram);
}

/**
 * The leg leaving an attach point has to head away from its own node. Without
 * this, a nudge is free to lift a channel that hangs below a gateway up past
 * the gateway's top -- the polyline still misses every *other* element, so it
 * scores as an improvement, while actually being drawn straight through its own
 * source (craft-graph's `lint_exhausted` left gw_lint's bottom edge and rose
 * back through it).
 */
function leavesOutward(
  pts: Array<{ x: number; y: number }>,
  srcNode: NodeLayout | undefined,
  tgtNode: NodeLayout | undefined,
): boolean {
  const ok = (attach: { x: number; y: number }, next: { x: number; y: number }, node?: NodeLayout): boolean => {
    if (!node) return true;
    if (Math.abs(attach.y - node.y) < 0.5) return next.y <= attach.y + 0.5;
    if (Math.abs(attach.y - (node.y + node.height)) < 0.5) return next.y >= attach.y - 0.5;
    if (Math.abs(attach.x - node.x) < 0.5) return next.x <= attach.x + 0.5;
    if (Math.abs(attach.x - (node.x + node.width)) < 0.5) return next.x >= attach.x - 0.5;
    return true;
  };
  return (
    ok(pts[0]!, pts[1]!, srcNode) && ok(pts[pts.length - 1]!, pts[pts.length - 2]!, tgtNode)
  );
}

/**
 * A routed polyline can still run a riser (or a descender) straight through a
 * node that happens to sit in the column it climbs: `no_tools` rose out of
 * `gw_tools` through `end_error`, `not_truncated` through `drain_followup`,
 * and `to_gw_followup` dropped through `gw_truncated`. Rather than teach each
 * routing case about every element that might be above or below it, nudge the
 * finished polyline: for each interior straight segment that intersects a node
 * it does not connect, try shifting that segment sideways (or up/down) into a
 * clear gap, keeping the polyline orthogonal by moving both of its endpoints.
 */
function repairSegmentCollisions(
  waypoints: Array<{ x: number; y: number }>,
  layout: ProcessLayoutResult,
  flow: any,
): Array<{ x: number; y: number }> {
  if (waypoints.length < 3) return waypoints;
  const endpoints = new Set([flow?.sourceRef?.id, flow?.targetRef?.id]);
  const obstacles = Array.from(layout.nodes.values()).filter(
    (n) => !endpoints.has(n.id) && n.element?.$type !== "bpmn:SubProcess",
  );

  const hits = (pts: Array<{ x: number; y: number }>): number => {
    let n = 0;
    for (let i = 0; i < pts.length - 1; i += 1) n += segmentHitCount(pts[i]!, pts[i + 1]!, obstacles);
    return n;
  };

  let best = waypoints;
  let bestHits = hits(best);
  if (bestHits === 0) return best;

  // Interior segments move freely; the first and last may only slide along the
  // edge of the node they attach to, so the polyline still meets its endpoints.
  const srcNode = layout.nodes.get(flow?.sourceRef?.id);
  const tgtNode = layout.nodes.get(flow?.targetRef?.id);
  const staysOnNode = (idx: number, moved: { x: number; y: number }): boolean => {
    const node = idx === 0 ? srcNode : idx === best.length - 1 ? tgtNode : undefined;
    if (!node) return true;
    return (
      moved.x >= node.x && moved.x <= node.x + node.width && moved.y >= node.y && moved.y <= node.y + node.height
    );
  };

  for (let i = 0; i < best.length - 1 && bestHits > 0; i += 1) {
    const a = best[i]!;
    const b = best[i + 1]!;
    const vertical = Math.abs(a.x - b.x) < 0.5;
    const horizontal = Math.abs(a.y - b.y) < 0.5;
    if (!vertical && !horizontal) continue;
    for (const delta of SEGMENT_NUDGES) {
      const candidate = best.map((p, idx) =>
        idx === i || idx === i + 1
          ? vertical
            ? { x: p.x + delta, y: p.y }
            : { x: p.x, y: p.y + delta }
          : { ...p },
      );
      if (!staysOnNode(i, candidate[i]!) || !staysOnNode(i + 1, candidate[i + 1]!)) continue;
      if (!leavesOutward(candidate, srcNode, tgtNode)) continue;
      const candidateHits = hits(candidate);
      if (candidateHits < bestHits) {
        best = candidate;
        bestHits = candidateHits;
        if (bestHits === 0) break;
      }
    }
  }

  // A final approach that still cannot be cleared is one where the target sits
  // directly above (or below) an element wide enough that no slide along the
  // target's own edge escapes it -- craft-graph's `rejected` rising out of the
  // return channel into `gw_rejected_entry`, which sits on top of
  // `apply_extension`. Take the vertical around the blocker and come in from
  // the side instead.
  if (bestHits > 0 && tgtNode) {
    // Two flows detouring around the same blocker into the same target would
    // otherwise pick the same bypass column and draw as one line, so stagger
    // them by their position among that target's incoming flows.
    const siblings = layout.allFlows.filter((f: any) => f.targetRef?.id === tgtNode.id);
    const rank = Math.max(0, siblings.findIndex((f: any) => f.id === flow?.id));
    const detour = approachFromSide(best, tgtNode, obstacles, rank * CHANNEL_LANE_GAP);
    if (detour && hits(detour) === 0) return detour;
  }
  return best;
}

/**
 * Rewrites a polyline's last vertical leg so it climbs clear of whatever is
 * between the channel and the target, then enters the target's nearer side.
 */
function approachFromSide(
  pts: Array<{ x: number; y: number }>,
  tgt: NodeLayout,
  obstacles: NodeLayout[],
  stagger = 0,
): Array<{ x: number; y: number }> | null {
  if (pts.length < 3) return null;
  const pen = pts[pts.length - 2]!;
  const end = pts[pts.length - 1]!;
  if (Math.abs(pen.x - end.x) > 0.5) return null;

  const blocking = obstacles.filter(
    (o) =>
      pen.x > o.x - SEGMENT_CLEARANCE &&
      pen.x < o.x + o.width + SEGMENT_CLEARANCE &&
      Math.max(Math.min(pen.y, end.y), o.y - SEGMENT_CLEARANCE) <
        Math.min(Math.max(pen.y, end.y), o.y + o.height + SEGMENT_CLEARANCE),
  );
  if (blocking.length === 0) return null;

  for (const dir of [1, -1] as const) {
    const bypassX =
      dir === 1
        ? Math.max(...blocking.map((o) => o.x + o.width)) + CHANNEL_CLEARANCE + stagger
        : Math.min(...blocking.map((o) => o.x)) - CHANNEL_CLEARANCE - stagger;
    const entryX = dir === 1 ? tgt.x + tgt.width : tgt.x;
    const candidate = [
      ...pts.slice(0, pts.length - 2).map((p) => ({ ...p })),
      { x: bypassX, y: pen.y },
      { x: bypassX, y: tgt.centerY },
      { x: entryX, y: tgt.centerY },
    ];
    // keep the leg that reaches `pen` orthogonal
    const before = candidate[candidate.length - 4];
    if (before && Math.abs(before.y - pen.y) > 0.5) return null;
    return candidate;
  }
  return null;
}

/** Nudge offsets tried in order: nearest first, both directions. */
const SEGMENT_NUDGES: number[] = (() => {
  const out: number[] = [];
  for (let d = 15; d <= 135; d += 15) out.push(d, -d);
  return out;
})();

/**
 * How many of `obstacles` an axis-aligned segment passes through, counting a
 * near miss as a hit: without the clearance the repair below is free to park a
 * channel exactly on a row of tasks' top edge, which is technically outside
 * every box and reads as a line drawn through them.
 */
const SEGMENT_CLEARANCE = 8;

function segmentHitCount(
  p: { x: number; y: number },
  q: { x: number; y: number },
  obstacles: NodeLayout[],
): number {
  let n = 0;
  for (const o of obstacles) {
    const x0 = o.x - SEGMENT_CLEARANCE;
    const y0 = o.y - SEGMENT_CLEARANCE;
    const x1 = o.x + o.width + SEGMENT_CLEARANCE;
    const y1 = o.y + o.height + SEGMENT_CLEARANCE;
    if (Math.abs(p.y - q.y) < 0.5) {
      if (p.y <= y0 || p.y >= y1) continue;
      if (Math.max(Math.min(p.x, q.x), x0) < Math.min(Math.max(p.x, q.x), x1)) n += 1;
    } else if (Math.abs(p.x - q.x) < 0.5) {
      if (p.x <= x0 || p.x >= x1) continue;
      if (Math.max(Math.min(p.y, q.y), y0) < Math.min(Math.max(p.y, q.y), y1)) n += 1;
    }
  }
  return n;
}

/** The Y a routed edge's channel runs at, from the process's channel plan. */
function channelY(
  layout: ProcessLayoutResult,
  flow: any,
  side: "above" | "below",
  x1: number,
  x2: number,
): number {
  return layout.channels?.channelY(flow?.id ?? "", side, x1, x2) ?? 0;
}

function computeWaypoints(
  src: NodeLayout,
  tgt: NodeLayout,
  layout: ProcessLayoutResult,
  opts: Required<AutoLayoutOptions>,
  flow?: any,
): Array<{ x: number; y: number }> {
  // Case 1: SubProcess child internal flow
  if (src.isSubProcessChild && tgt.isSubProcessChild) {
    return [
      { x: src.x + src.width, y: src.centerY },
      { x: tgt.x, y: tgt.centerY },
    ];
  }

  const minTrack = Math.min(0, ...Array.from(layout.nodes.values()).map((n) => n.track));

  // Case 1.5: Upside route between exclusive gateways to prevent lane collisions
  if (shouldUseUpsideRoute(src, tgt, layout, flow?.id)) {
    const upperChannelY = channelY(layout, flow, "above", src.centerX, tgt.centerX);
    return [
      { x: src.centerX, y: src.y },
      { x: src.centerX, y: upperChannelY },
      { x: tgt.centerX, y: upperChannelY },
      { x: tgt.centerX, y: tgt.y },
    ];
  }

  // Case 2: Loop-back / Back-edge (target column <= source column)
  if (tgt.col <= src.col) {
    const lane = channelY(layout, flow, "below", src.centerX, tgt.centerX);

    return [
      { x: src.centerX, y: src.y + src.height },
      { x: src.centerX, y: lane },
      { x: tgt.centerX, y: lane },
      { x: tgt.centerX, y: tgt.y + tgt.height },
    ];
  }

  // Case 3: Same track, forward flow
  if (src.track === tgt.track) {
    // Check if any node on the same track lies between src and tgt
    const hasObstacle = Array.from(layout.nodes.values()).some(
      (n) =>
        n.id !== src.id &&
        n.id !== tgt.id &&
        n.track === src.track &&
        !n.isSubProcessChild &&
        n.centerX > src.centerX &&
        n.centerX < tgt.centerX,
    );

    const srcExitY = src.element.$type === "bpmn:SubProcess" ? opts.track1Y : src.centerY;
    const tgtEntryY = tgt.element.$type === "bpmn:SubProcess" ? opts.track1Y : tgt.centerY;

    if (!hasObstacle) {
      return [
        { x: src.x + src.width, y: srcExitY },
        { x: tgt.x, y: tgtEntryY },
      ];
    }

    // Forward bypass skipping intermediate elements on same track via channel
    const lane = channelY(layout, flow, "below", src.centerX, tgt.centerX);
    return [
      { x: src.centerX, y: src.y + src.height },
      { x: src.centerX, y: lane },
      { x: tgt.centerX, y: lane },
      { x: tgt.centerX, y: tgt.y + tgt.height },
    ];
  }

  // Case 4: Branching UP from gateway to upper track (e.g. Track 0 -> Track -1)
  if (src.track > tgt.track && src.element.$type.endsWith("Gateway") && !tgt.element.$type.endsWith("Gateway")) {
    // Rising at src.centerX and then running left to `tgt.x` only makes sense
    // while the gateway is left of the target. When it is under (or right of)
    // it, that last leg doubles back *through* the target -- what put
    // `no_tools` inside `end_error` and `not_truncated` inside
    // `drain_followup`. Enter the nearest edge instead.
    if (src.centerX >= tgt.x && src.centerX <= tgt.x + tgt.width) {
      return [
        { x: src.centerX, y: src.y },
        { x: src.centerX, y: tgt.y + tgt.height },
      ];
    }
    const entryX = src.centerX > tgt.x + tgt.width ? tgt.x + tgt.width : tgt.x;
    // A gateway is only 50px wide, so when something sits in the column
    // directly above it the riser cannot simply slide clear (repairSegment-
    // Collisions keeps an attach point on its own node's edge). Leave by the
    // side instead and climb in the gap between the two elements.
    const direct = [
      { x: src.centerX, y: src.y },
      { x: src.centerX, y: tgt.centerY },
      { x: entryX, y: tgt.centerY },
    ];
    const blockers = Array.from(layout.nodes.values()).filter(
      (n) => n.id !== src.id && n.id !== tgt.id && n.element?.$type !== "bpmn:SubProcess",
    );
    if (segmentHitCount(direct[0]!, direct[1]!, blockers) > 0 && entryX === tgt.x) {
      // Climb out of the gateway's own column only as far as the blocker's
      // lower edge, cross into the gap between the two elements, and finish the
      // climb there. Leaving by the gateway's right side instead would work,
      // but would share that stub with the gateway's own forward flow.
      const gapX = (src.x + src.width + tgt.x) / 2;
      const blockerBottom = Math.max(
        tgt.y + tgt.height,
        ...blockers
          .filter((n) => n.x < src.centerX && src.centerX < n.x + n.width && n.y + n.height < src.y)
          .map((n) => n.y + n.height),
      );
      const midY = (blockerBottom + src.y) / 2;
      const jog = [
        { x: src.centerX, y: src.y },
        { x: src.centerX, y: midY },
        { x: gapX, y: midY },
        { x: gapX, y: tgt.centerY },
        { x: tgt.x, y: tgt.centerY },
      ];
      let jogHits = 0;
      for (let i = 0; i < jog.length - 1; i += 1) jogHits += segmentHitCount(jog[i]!, jog[i + 1]!, blockers);
      if (jogHits === 0) return jog;
    }
    return direct;
  }

  // Case 5: Merging DOWN from upper track into a gateway (e.g. Track -1 -> Track 0)
  if (src.track < tgt.track && tgt.element.$type.endsWith("Gateway") && src.centerY < tgt.centerY) {
    return [
      { x: src.x + src.width, y: src.centerY },
      { x: tgt.centerX, y: src.centerY },
      { x: tgt.centerX, y: tgt.y },
    ];
  }

  // Case 6: Branching down from gateway to lower track
  if (src.track < tgt.track) {
    // Exits bottom of gateway
    if (src.element.$type.endsWith("Gateway")) {
      // Same as case 4, mirrored: a horizontal leg back to `tgt.x` would run
      // through the target when the gateway is not left of it.
      if (src.centerX >= tgt.x && src.centerX <= tgt.x + tgt.width) {
        return [
          { x: src.centerX, y: src.y + src.height },
          { x: src.centerX, y: tgt.y },
        ];
      }
      const entryX = src.centerX > tgt.x + tgt.width ? tgt.x + tgt.width : tgt.x;
      return [
        { x: src.centerX, y: src.y + src.height },
        { x: src.centerX, y: tgt.centerY },
        { x: entryX, y: tgt.centerY },
      ];
    }
    // Exits right of task, drops to target centerY
    return [
      { x: src.x + src.width, y: src.centerY },
      { x: (src.x + src.width + tgt.x) / 2, y: src.centerY },
      { x: (src.x + src.width + tgt.x) / 2, y: tgt.centerY },
      { x: tgt.x, y: tgt.centerY },
    ];
  }

  // Case 7: Merging up from lower track into a gateway
  if (src.track > tgt.track && tgt.element.$type.endsWith("Gateway")) {
    const isOtherExit = layout.allFlows.some(
      (f) => f.id !== flow?.id && f.sourceRef?.id === src.id && (layout.nodes.get(f.targetRef?.id)?.track ?? 0) < src.track,
    );
    const otherFlow = layout.allFlows.find(
      (f) => f.id !== flow?.id && f.sourceRef?.id === src.id && (layout.nodes.get(f.targetRef?.id)?.track ?? 0) < src.track,
    );
    const otherTgt = otherFlow ? layout.nodes.get(otherFlow.targetRef?.id) : null;
    const isLonger = otherTgt ? tgt.col > otherTgt.col : false;

    if (isOtherExit && isLonger && src.element.$type.endsWith("Gateway")) {
      const lane = channelY(layout, flow, "below", src.centerX, tgt.centerX);
      return [
        { x: src.centerX, y: src.y + src.height },
        { x: src.centerX, y: lane },
        { x: tgt.centerX, y: lane },
        { x: tgt.centerX, y: tgt.y + tgt.height },
      ];
    }

    // Running along `src.centerY` all the way to the target's column only works
    // while nothing sits between them on that track. In craft-graph it did not:
    // `lint_exhausted` (gw_lint -> gw_rejected_entry) crossed review_fragment,
    // gw_approve and apply_extension in one straight line. Drop into a channel
    // instead, exactly as the branch above does.
    const straight = [
      { x: src.x + src.width, y: src.centerY },
      { x: tgt.centerX, y: src.centerY },
      { x: tgt.centerX, y: tgt.y + tgt.height },
    ];
    const between = Array.from(layout.nodes.values()).filter(
      (n) => n.id !== src.id && n.id !== tgt.id && n.element?.$type !== "bpmn:SubProcess",
    );
    if (segmentHitCount(straight[0]!, straight[1]!, between) > 0) {
      const lane = channelY(layout, flow, "below", src.centerX, tgt.centerX);
      return [
        { x: src.centerX, y: src.y + src.height },
        { x: src.centerX, y: lane },
        { x: tgt.centerX, y: lane },
        { x: tgt.centerX, y: tgt.y + tgt.height },
      ];
    }
    return straight;
  }

  // Fallback orthogonal
  return [
    { x: src.x + src.width, y: src.centerY },
    { x: tgt.centerX, y: src.centerY },
    { x: tgt.centerX, y: tgt.centerY },
    { x: tgt.x, y: tgt.centerY },
  ];
}
