import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router-dom";
import { router } from "./App";
import { AuthProvider } from "./auth";
import { AppProvider } from "./AppContext";
import { ToastProvider } from "./components/Toast";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // I dati di portafoglio cambiano quando l'utente inserisce un movimento o
      // quando gira lo scheduler, non al secondo: un minuto di staleTime evita
      // una tempesta di richieste navigando tra le pagine.
      staleTime: 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// #root è in index.html: se manca, la SPA non ha dove montarsi e l'unica cosa
// utile è dirlo subito invece di far fallire createRoot con "container is null".
const container = document.getElementById("root");
if (!container) throw new Error("#root non trovato: index.html non è quello atteso");

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthProvider>
          <AppProvider>
            <RouterProvider router={router} />
          </AppProvider>
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>
);
