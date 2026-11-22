import { createRoot } from "react-dom/client";
import { App } from "./components/App.tsx";
import { warmWorkers } from "./data/worker-client.ts";
import "./styles.css";
import "./fonts.css";

createRoot(document.getElementById("root")!).render(<App />);

// Spawn the load workers once the Open screen has painted; a drop then starts parsing immediately.
setTimeout(warmWorkers);
