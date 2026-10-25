import { threadCpuUsage } from 'node:process';

interface CpuMeasurementStart {
  threadCpu: ReturnType<typeof threadCpuUsage>;
  wallMilliseconds: number;
  memory: ReturnType<typeof process.memoryUsage>;
  resources: ReturnType<typeof process.resourceUsage>;
}

export interface ParseCpuMeasurement {
  threadCpuMicroseconds: number;
  elapsedWallMicroseconds: number;
  processHeapUsedBytes: [number, number];
  processResidentBytes: [number, number];
  processVoluntaryContextSwitches: number;
  processInvoluntaryContextSwitches: number;
  processMinorPageFaults: number;
  processMajorPageFaults: number;
}

export function startCpuMeasurement(): CpuMeasurementStart {
  const memory = process.memoryUsage();
  const resources = process.resourceUsage();
  const wallMilliseconds = performance.now();
  const threadCpu = threadCpuUsage();
  return { threadCpu, wallMilliseconds, memory, resources };
}

export function finishCpuMeasurement(start: CpuMeasurementStart): ParseCpuMeasurement {
  const cpu = threadCpuUsage(start.threadCpu);
  const elapsedWallMicroseconds = (performance.now() - start.wallMilliseconds) * 1000;
  const memory = process.memoryUsage();
  const resources = process.resourceUsage();
  return {
    threadCpuMicroseconds: cpu.user + cpu.system,
    elapsedWallMicroseconds,
    processHeapUsedBytes: [start.memory.heapUsed, memory.heapUsed],
    processResidentBytes: [start.memory.rss, memory.rss],
    processVoluntaryContextSwitches: resources.voluntaryContextSwitches - start.resources.voluntaryContextSwitches,
    processInvoluntaryContextSwitches:
      resources.involuntaryContextSwitches - start.resources.involuntaryContextSwitches,
    processMinorPageFaults: resources.minorPageFault - start.resources.minorPageFault,
    processMajorPageFaults: resources.majorPageFault - start.resources.majorPageFault,
  };
}
