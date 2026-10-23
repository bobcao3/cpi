---
name: performance-engineer
description:
  Perf optimization or when reviewing perf sensitive code before completion.
  Trigger when user requests optimization, analysis, timing, benchmarking, why
  is it slow / why is this fast.
---

# General guiding principles

1. Always compare to the speed-of-light. Comparison with other / previous
   implementations are helpful but often miss the big picture. The goal, when
   not changing underlying algorithm, is to always hit the speed of light, where
   no further optimization is possible. Evaluate implementations in terms of
   achieved compute ops/s, or achieved memory bandwidth GB/s, etc.
2. Do not optimize things that serves no real purpose, delete them. Check and
   delete typical anti-patterns: Extra memory copies, unnecessary dynamic
   allocation, unnecessary (virtualized) abstractions.
3. Make code predicable, modern CPUs should hit over 4 IPC on predicable code.
4. Sometimes the greatest performance gains come from a better architecture.
   Many algorithms can be restructured to gain much better vectorization or
5. When reporting about performance, compare it to speed of light metrics.
6. Make benchmarks easily repeatable and reproducible with a single command.

# Common pitfalls to avoid

1. Using small scalar memory operations instead of vector memory operations.
2. Loop structures unfriendly to compiler auto-vectorization.
3. Bad layout causing bank conflicts, false sharing, cache invalidations, etc.
4. Abstraction, wrapper, or type erasure that prevents compiler from
   optimization. e.g. "paint_pixel" helper that hides the underlying data
   layout.
5. Wasteful memory layouts, e.g. bloating array of structs with long tail
   fields.
6. Tunnel vision on a single metric or "the bottleneck" when the best solution
   might be a restructure that completely bypasses the current bottleneck.
7. Measuring the wrong thing, e.g. using host wall clock times to measure async
   GPU spans, overhead leaking into measured spans, measuring compute throughput
   on memory bound routines, etc.
8. Bench-maxxing a single shape of input or failed to collect production backed
   input shjapes.
9. Branching when it won't save compute or memory access.
10. Bad code strucuture that hides inherit parallelism intrinsic in most code
    (even scalar code). Use packeting.

# Methodology

1. Identify and quantify current performance against speed of light first.
2. Add instrumentation or use non intrusive profiling.
3. Break down the problem and get detailed measurements, attributable to
   specific code spans or structs.

For each sub-problem, repeat the following:

- Review the code for common pitfalls, fix low hanging fruit issues first.
- Bound the benchmark and test time against speed of light: no point wasting
  time in running benchmarks that we know is way short of the goal.
- Predict the impact before experimentation, but do not throw away an idea
  because the prediction shows little gain, and always compare achieved results
  with prediction.
- When experimentation is within noise, do not throw away attempts that reduces
  complexity or improves performance in theory if current wall is removed.
