export const flow = "flowchart LR\na[Client] --> b[Service]";

export const families = [
  ["Flowchart", flow],
  ["Sequence", "sequenceDiagram\nAlice->>Bob: Hello\nBob-->>Alice: Accepted"],
  ["Class", "classDiagram\nclass Account\nclass User\nUser --> Account"],
  ["Entity relationship", "erDiagram\nUSER ||--o{ ORDER : places"],
  ["State v2", "stateDiagram-v2\n[*] --> Ready\nReady --> Done\nDone --> [*]"],
  ["State legacy", "stateDiagram\n[*] --> Waiting\nWaiting --> Active"],
] as const;

export const branches =
  'graph TD\nA[1024] --> B[512]\nA --> BF[512 free]\nB --> C[256]\nB --> CF[256 free]\nC --> D["128 allocated<br/>holds 100 byte request"]\nC --> DF[128 free]';

export function chart(
  series: "bar" | "line" | "combined",
  horizontal = false,
): string {
  const header = series === "combined" ? "xychart" : "xychart-beta";
  const data =
    series === "combined"
      ? "bar [3, 11, 6, 8]\nline [2, 9, 7, 4]"
      : `${series} [3, 11, 6, 8]`;
  return `${header}${horizontal ? " horizontal" : ""}\ntitle "Requests by region: uneven traffic"\nx-axis ["East coast", "West coast", "北部", "South zone"]\ny-axis "Count" 0 --> 12\n${data}`;
}

export const fence = (source: string, marker = "```") =>
  `${marker}mmd\n${source}\n${marker}`;
