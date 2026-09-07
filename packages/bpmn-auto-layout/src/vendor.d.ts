declare module "bpmn-moddle" {
  export class BpmnModdle {
    constructor(options?: unknown);
    fromXML(xml: string): Promise<{ rootElement: unknown }>;
    toXML(rootElement: unknown, options?: { format?: boolean }): Promise<{ xml: string }>;
    create(type: string, attrs?: Record<string, unknown>): unknown;
  }
}

declare module "zeebe-bpmn-moddle/resources/zeebe.json" {
  const descriptor: Record<string, unknown>;
  export default descriptor;
}
