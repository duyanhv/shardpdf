/** Full end-to-end run from an external consumer: generate a real PDF. */
import { generate } from "@shardpdf/orchestrator";
// Imported for resolution only: workers load the adapter by module specifier
// in a child process, so the plan references the file rather than this binding.
import "./my-adapter.ts";

const grades = Array.from({ length: 90 }, (_u, i) => (i % 5) + 1);
const result = await generate(
  {
    adapter: {
      module: new URL("./my-adapter.ts", import.meta.url).pathname,
      export: "adapter",
      version: "consumer-1",
    },
    sections: [
      {
        id: "u1",
        data: { kind: "unit", grades: grades.slice(0, 30) },
        pageEstimate: 30,
      },
      {
        id: "u2",
        data: { kind: "unit", grades: grades.slice(30, 60) },
        pageEstimate: 30,
      },
      {
        id: "u3",
        data: { kind: "unit", grades: grades.slice(60) },
        pageEstimate: 30,
      },
    ],
  },
  {
    outputPath: "./out/consumer.pdf",
    maxPagesPerShard: 30,
    outline: [
      { title: "Units 1-30", anchor: "sec:u1" },
      { title: "Units 31-60", anchor: "sec:u2" },
      { title: "Units 61-90", anchor: "sec:u3" },
    ],
  },
);
console.log(JSON.stringify(result));
