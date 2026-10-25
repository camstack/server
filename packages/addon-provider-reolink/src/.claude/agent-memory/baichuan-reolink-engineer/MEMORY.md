# Baichuan Reolink Engineer — Memory Index

- [GetEnc cmd56 wake-burst asymmetry (camstack vs plugin catalog)](getenc_wake_burst_asymmetry.md) — WHY GetEnc(cmd56) times out on camstack but not plugin catalog on the same battery doorbell: camstack fans out a concurrent command BURST on one BCUDP socket at each wake + re-fires getEnc on a poll; plugin catalog is fully sequential, caches getVideoStreamOptions, and does NOTHING proactive on awake.
