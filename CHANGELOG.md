# Changelog

## [0.2.0](https://github.com/kontourai/plumb/compare/v0.1.0...v0.2.0) (2026-10-12)


### Features

* share bounded check observations without escalation ([292546c](https://github.com/kontourai/plumb/commit/292546c4ed651de0eaf5d9ed3e278ef0b16047bb))
* shared check observations for kit and governance consumers ([#43](https://github.com/kontourai/plumb/issues/43)) ([3490e17](https://github.com/kontourai/plumb/commit/3490e175a2586431e43d4e56fd6d6ae635628f95))


### Bug Fixes

* give each context name its own lock and cooldown files ([#41](https://github.com/kontourai/plumb/issues/41)) ([a942baa](https://github.com/kontourai/plumb/commit/a942baac7e6863ba39972d70987909f3a724a674))
* honor caller escalateOptions in run() and refuse conflicting ones ([#40](https://github.com/kontourai/plumb/issues/40)) ([7a37adf](https://github.com/kontourai/plumb/commit/7a37adf2d2674a0021101ae995d69a18dbae6465))
* refuse malformed guard settings and keep a live lock exclusive ([#39](https://github.com/kontourai/plumb/issues/39)) ([a08255e](https://github.com/kontourai/plumb/commit/a08255e8c3820bcf8f5412325edc42b5eb32d8cc))

## 0.1.0 (2026-07-18)


### Features

* first-class deploy context — plumb run --context deploy=&lt;sha&gt; ([#16](https://github.com/kontourai/plumb/issues/16)) ([c8a876c](https://github.com/kontourai/plumb/commit/c8a876c217ca8a2f31cbf35ab10278f077c937bd))
* rate-limit escalations (per-context cooldown, daily cap, per-context lock) ([#12](https://github.com/kontourai/plumb/issues/12)) ([5703613](https://github.com/kontourai/plumb/commit/5703613283ee0b9b7318a0c592a6ae0b52e5437f))
* TypeScript package (@kontourai/plumb) ([#14](https://github.com/kontourai/plumb/issues/14)) ([9eb011f](https://github.com/kontourai/plumb/commit/9eb011ffde5ffaed9d1128ec5717c34b49d2396c))


### Miscellaneous Chores

* initial version 0.1.0 ([8fb5f6f](https://github.com/kontourai/plumb/commit/8fb5f6fbdf1f47bb1031febee1b73e44434e3882))
