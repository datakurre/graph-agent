# BPMN Auto Layout

Private, copyable BPMN layout utilities used by graph-agent.

```ts
import { layoutProcess, ensureLabelDi } from "@graph-agent/bpmn-auto-layout";

const laidOut = await layoutProcess(xml);
const complete = await ensureLabelDi(laidOut);
```

`layoutProcess` accepts BPMN XML and returns BPMN XML with generated BPMN DI
for every top-level process, including orthogonal sequence-flow routing and
external labels. The current implementation uses `zeebe-bpmn-moddle` and is
intended for Camunda 8-flavoured BPMN documents.

The package is private and is not published. To reuse it in another project,
copy this directory and install its dependencies before running `npm run build`.
