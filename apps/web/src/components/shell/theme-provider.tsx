"use client";

import { ThemeProvider as NextThemeProvider } from "next-themes";
import type { ReactNode } from "react";

export function ThemeProvider({ children, nonce }: { readonly children: ReactNode; readonly nonce?: string }) {
  return (
    <NextThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      {...(nonce === undefined ? {} : { nonce })}
    >
      {children}
    </NextThemeProvider>
  );
}
