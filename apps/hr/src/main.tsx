import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { initializeLiff } from "./auth/liff.js";
import { App } from "./App.js";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false },
  },
});

const root = document.getElementById("root");
if (!root) throw new Error("找不到 #root。");

const reactRoot = createRoot(root);
void initializeLiff().then(() => {
  // 保留 App 的宣告式 Routes，只提供 data router，讓排班的返回／前進也能阻擋離頁。
  const router = createBrowserRouter([{ path: "*", element: <App /> }]);
  reactRoot.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
}).catch((error: unknown) => {
  console.error("LIFF 初始化失敗。", error);
  reactRoot.render(
    <main className="hr-liff-startup-error" role="alert">
      <h1>LINE 打卡載入失敗</h1>
      <p>無法連線到 LINE 登入服務，請確認網路後重新開啟打卡頁。</p>
      <button type="button" onClick={() => window.location.reload()}>重新載入</button>
    </main>,
  );
});
