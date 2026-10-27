// Dev helper: run the simulator through bus + rpm model and print a trace.
import { createSimulator } from '../src/input/simulator.js'
import { createInputBus } from '../src/input/inputBus.js'
import { inputConfig } from '../src/input/config.js'
import { createRpmModel } from '../src/vehicle/rpmModel.js'
import { vehicleConfig } from '../src/vehicle/config.js'

const [thr = '1', dur = '14', brakeAt = '99'] = process.argv.slice(2)
const sim = createSimulator(), bus = createInputBus(inputConfig), m = createRpmModel(vehicleConfig)
m.forceRunning()
const dt = 1 / 60
for (let i = 0; i < Number(dur) * 60; i++) {
  const now = i * dt * 1000
  if (i * dt >= Number(brakeAt)) { sim.setThrottle(0); sim.setBrake(0.6) } else sim.setThrottle(Number(thr))
  bus.push(sim.step(dt, now))
  const e = bus.estimate(now)
  const f = m.step(dt, e)
  for (const ev of f.events) console.log(`  ${(i*dt).toFixed(2)}s ${ev.type} ${ev.from ?? ''}->${ev.to ?? ''}`)
  if (i % 30 === 0) console.log(`${(i*dt).toFixed(1)}s v=${(e.speedMps*2.237).toFixed(1)}mph g=${f.gear} rpm=${f.rpm.toFixed(0)} load=${f.load.toFixed(2)}`)
}
