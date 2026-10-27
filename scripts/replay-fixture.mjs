// Dev helper: run a fixture through replay → bus → rpm model; print a coarse trace.
import { readFileSync } from 'node:fs'
import { createReplay } from '../src/input/replay.js'
import { createInputBus } from '../src/input/inputBus.js'
import { inputConfig } from '../src/input/config.js'
import { createRpmModel } from '../src/vehicle/rpmModel.js'
import { vehicleConfig } from '../src/vehicle/config.js'
const name = process.argv[2]
const trace = JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url)))
const bus = createInputBus(inputConfig), m = createRpmModel(vehicleConfig)
m.forceRunning()
const rep = createReplay(trace, inputConfig.gps, { onSample: (s) => bus.push(s) })
const dt = 1 / 60
for (let i = 0; i <= trace.durationS * 60; i++) {
  const now = i * dt * 1000
  rep.step(now)
  const e = bus.estimate(now), f = m.step(dt, e)
  for (const ev of f.events) console.log(`  ${(i*dt).toFixed(2)}s ${ev.type} ${ev.from ?? ''}->${ev.to ?? ''}`)
  if (i % 60 === 0) {
    const truth = trace.truth.find((x) => x.t >= now)
    console.log(`${(i*dt).toFixed(0)}s ${e.status} v=${(e.speedMps*2.237).toFixed(1)} true=${(truth.speed*2.237).toFixed(1)} g=${f.gear} rpm=${f.rpm.toFixed(0)} load=${f.load.toFixed(2)}`)
  }
}
console.log('processor', rep.processor.stats)
