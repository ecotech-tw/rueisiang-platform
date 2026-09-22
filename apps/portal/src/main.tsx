import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App.js";
import { UnsavedChangesProvider } from "./shell/UnsavedChanges.js";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false },
  },
});

const root = document.getElementById("root");
if (!root) throw new Error("找不到 #root。");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        {/* 要在 Router 裡面：攔截之後是用 react-router 的 navigate 真的走過去。 */}
        <UnsavedChangesProvider>
          <App />
        </UnsavedChangesProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
