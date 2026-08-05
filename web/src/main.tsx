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

createRoot(document.getElementById("root")).render(
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
