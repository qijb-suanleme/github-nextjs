
import { ThemeSwitcher } from "@/components/theme-switcher";
import Header from "@/components/header";
import { AuthProvider } from "@/contexts/auth-context";
import { AuthGuard } from "@/components/auth-guard";
import { ErrorBoundary } from "@/components/error-boundary";
import { NotificationProvider } from "@/components/notification";

export default function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ErrorBoundary>
      <NotificationProvider>
        <AuthProvider>
          <AuthGuard>
            <main className="min-h-screen flex flex-col items-center container mx-auto max-w-7xl">
              <div className="flex-1 w-full flex flex-col gap-20 items-center">
                <Header />
                <div className="flex-1 flex flex-col gap-20 w-full p-5">
                  {children}
                </div>

                <footer className="w-full flex items-center justify-center border-t mx-auto text-center text-xs gap-8 py-16">
                  <p>
                    Powered by{" "}
                    <a
                      href="https://supabase.com/?utm_source=create-next-app&utm_medium=template&utm_term=nextjs"
                      target="_blank"
                      className="font-bold hover:underline"
                      rel="noreferrer"
                    >
                      Supabase
                    </a>
                  </p>
                  <ThemeSwitcher />
                </footer>
              </div>
            </main>
          </AuthGuard>
        </AuthProvider>
      </NotificationProvider>
    </ErrorBoundary>
  );
}
