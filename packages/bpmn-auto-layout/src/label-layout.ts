interface Bounds {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

interface ValidBounds extends Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ElementLike {
  id: string;
  $type: string;
  name?: string;
  flowElements?: ElementLike[];
  laneSets?: Array<{ lanes?: ElementLike[] }>;
  childLaneSet?: { lanes?: ElementLike[] };
  $parent?: ElementLike;
}

interface LabelLike {
  bounds?: Bounds;
}

interface DiLike {
  bpmnElement?: ElementLike;
  bounds?: Bounds;
  label?: LabelLike;
}

interface DiagramLike {
  plane?: {
    bpmnElement?: ElementLike;
    planeElement?: DiLike[];
  };
}

interface DefinitionsLike extends ElementLike {
  rootElements?: ElementLike[];
  diagrams?: DiagramLike[];
}

interface ReporterLike {
  report(id: string, message: string): void;
}

interface LabelRecord {
  target: ElementLike;
  bounds: ValidBounds;
  di: DiLike;
}

function isEventOrGateway(element: ElementLike): boolean {
  return element.$type.endsWith("Event") || element.$type.endsWith("Gateway");
}

function isExternalLabelTarget(element: ElementLike): boolean {
  return (
    isEventOrGateway(element) ||
    element.$type === "bpmn:SequenceFlow" ||
    element.$type === "bpmn:MessageFlow" ||
    element.$type === "bpmn:DataStoreReference" ||
    element.$type === "bpmn:DataObjectReference" ||
    element.$type === "bpmn:Group"
  );
}

function hasVisibleName(element: ElementLike): boolean {
  return typeof element.name === "string" && element.name.trim().length > 0;
}

/** Materialize the same default label rectangles bpmn-js uses before linting or saving. */
export async function ensureLabelDi(xml: string): Promise<string> {
  const moddle = new BpmnModdle({ zeebe });
  const { rootElement } = await moddle.fromXML(xml);
  const definitions = rootElement as unknown as DefinitionsLike;
  const diagrams = definitions.diagrams ?? [];

  const addForProcess = (process: ElementLike) => {
    const diagram = diagrams.find((candidate) => candidate.plane?.bpmnElement?.id === process.id);
    if (!diagram?.plane) return;
    const diById = new Map(
      (diagram.plane.planeElement ?? [])
        .filter((di) => di.bpmnElement?.id)
        .map((di) => [di.bpmnElement!.id, di] as const),
    );
    const elements: ElementLike[] = [];
    const visit = (element: ElementLike) => {
      elements.push(element);
      for (const child of element.flowElements ?? []) visit(child);
    };
    for (const element of process.flowElements ?? []) visit(element);
    for (const laneSet of process.laneSets ?? []) for (const lane of laneSet.lanes ?? []) elements.push(lane);
    for (const lane of process.childLaneSet?.lanes ?? []) elements.push(lane);

    for (const element of elements) {
      const needsLabel = (isEventOrGateway(element) || element.$type === "bpmn:Lane") && hasVisibleName(element);
      if (!needsLabel) continue;
      const di = diById.get(element.id);
      if (!di?.bounds || !validBounds(di.bounds) || validBounds(di.label?.bounds)) continue;
      const labelBounds =
        element.$type === "bpmn:Lane"
          ? { x: di.bounds.x - di.bounds.height / 2 + 15, y: di.bounds.y + di.bounds.height / 2 - 15, width: di.bounds.height, height: 30 }
          : { x: di.bounds.x + di.bounds.width / 2 - 45, y: di.bounds.y + di.bounds.height, width: 90, height: 20 };
      di.label = moddle.create("bpmndi:BPMNLabel", {
        bounds: moddle.create("dc:Bounds", labelBounds),
      }) as unknown as LabelLike;
    }
  };

  for (const process of definitions.rootElements ?? []) {
    if (process.$type === "bpmn:Process") addForProcess(process);
  }
  return (await moddle.toXML(definitions as never, { format: true })).xml;
}

function validBounds(bounds: Bounds | undefined): bounds is ValidBounds {
  if (!bounds) return false;
  const { x, y, width, height } = bounds;
  return (
    typeof x === "number" &&
    Number.isFinite(x) &&
    typeof y === "number" &&
    Number.isFinite(y) &&
    typeof width === "number" &&
    Number.isFinite(width) &&
    typeof height === "number" &&
    Number.isFinite(height) &&
    width >= 0 &&
    height >= 0
  );
}

function overlaps(a: ValidBounds, b: ValidBounds): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function contains(outer: ValidBounds, inner: ValidBounds): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function isContainer(element: ElementLike): boolean {
  return ["bpmn:Lane", "bpmn:Participant", "bpmn:SubProcess"].includes(element.$type);
}

/** Validate serialized bpmn-js label placement without reproducing its adaptive positioning. */
export function labelLayout() {
  return {
    check(node: ElementLike, reporter: ReporterLike) {
      if (node.$type !== "bpmn:Definitions") return;
      const definitions = node as DefinitionsLike;
      const processes = (definitions.rootElements ?? []).filter((element) => element.$type === "bpmn:Process");

      for (const process of processes) {
        const diagram = (definitions.diagrams ?? []).find(
          (candidate) => candidate.plane?.bpmnElement?.id === process.id,
        );
        if (!diagram?.plane) continue;

        const diElements = diagram.plane.planeElement ?? [];
        const diById = new Map(
          diElements
            .filter((di) => di.bpmnElement?.id)
            .map((di) => [di.bpmnElement!.id, di] as const),
        );
        const elements: ElementLike[] = [];
        const visit = (element: ElementLike) => {
          elements.push(element);
          for (const child of element.flowElements ?? []) visit(child);
        };
        for (const element of process.flowElements ?? []) visit(element);
        for (const laneSet of process.laneSets ?? []) {
          for (const lane of laneSet.lanes ?? []) elements.push(lane);
        }
        for (const lane of process.childLaneSet?.lanes ?? []) elements.push(lane);

        const labels: LabelRecord[] = [];
        for (const element of elements) {
          const di = diById.get(element.id);
          const hasName = typeof element.name === "string" && element.name.trim().length > 0;
          const requiresLabel = isEventOrGateway(element) || element.$type === "bpmn:Lane";
          if (requiresLabel && hasName && !di?.label) {
            reporter.report(element.id, "Named element is missing its BPMN label DI");
          }
          if (!di?.label) continue;
          if (!validBounds(di.label.bounds)) {
            reporter.report(element.id, "BPMN label is missing valid bounds");
            continue;
          }
          if (isExternalLabelTarget(element)) labels.push({ target: element, bounds: di.label.bounds, di });
          if (element.$type === "bpmn:Lane" && di.bounds && validBounds(di.bounds) && !contains(di.bounds, di.label.bounds)) {
            reporter.report(element.id, "Lane label must remain inside its lane boundary");
          }
        }

        for (let i = 0; i < labels.length; i += 1) {
          const label = labels[i]!;
          const targetDi = diById.get(label.target.id);
          const targetBounds = targetDi?.bounds;
          if (validBounds(targetBounds)) {
            for (const di of diElements) {
              const element = di.bpmnElement;
              if (!element || element.id === label.target.id || !validBounds(di.bounds)) continue;
              if (isContainer(element) && contains(di.bounds, targetBounds)) continue;
              if (element.$type.endsWith("Flow") || element.$type === "bpmn:SequenceFlow") continue;
              if (overlaps(label.bounds, di.bounds)) {
                reporter.report(label.target.id, `BPMN label overlaps element '${element.id}'`);
              }
            }
          }

          for (let j = i + 1; j < labels.length; j += 1) {
            const other = labels[j]!;
            if (other.target.id !== label.target.id && overlaps(label.bounds, other.bounds)) {
              reporter.report(label.target.id, `BPMN label overlaps label for '${other.target.id}'`);
              reporter.report(other.target.id, `BPMN label overlaps label for '${label.target.id}'`);
            }
          }

          if (validBounds(targetBounds)) {
            const boundaries = diElements.filter((di) => {
              const element = di.bpmnElement;
              return (
                element &&
                (element.$type === "bpmn:Lane" || element.$type === "bpmn:Participant") &&
                element.id !== label.target.id &&
                validBounds(di.bounds) &&
                contains(di.bounds, targetBounds)
              );
            });
            for (const boundary of boundaries) {
              if (validBounds(boundary.bounds) && !contains(boundary.bounds, label.bounds)) {
                reporter.report(label.target.id, `BPMN label must remain inside boundary '${boundary.bpmnElement!.id}'`);
              }
            }
          }
        }
      }
    },
  };
}
import { BpmnModdle } from "bpmn-moddle";
import zeebe from "zeebe-bpmn-moddle/resources/zeebe.json" with { type: "json" };
