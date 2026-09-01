# Daymark core interaction prototype

> THROWAWAY PROTOTYPE — this is not production code and has no persistence.

Question: which page structure best supports the core loop of choosing a task, placing it on the day, starting it, and recording progress?

Run from the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File .\prototype\daymark-core\serve.ps1
```

Then open `http://127.0.0.1:4173/?variant=A`. Use the floating bottom bar or the left/right arrow keys to switch between variants A, B, and C.

All data is held in memory and resets on reload. Once a direction is chosen, record the verdict in `PROTOTYPE-NOTES.md`, delete the losing variants, and reimplement the validated direction in the production app.
