import { createRoot } from "react-dom/client";
import { App } from "./components/App.tsx";
import "./styles.css";
import "./fonts.css";

createRoot(document.getElementById("root")!).render(<App />);
