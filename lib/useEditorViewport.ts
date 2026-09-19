"use client";
import { useEffect, type RefObject } from "react";

// Follow the actually visible viewport, including keyboard resize/pan on iOS.
// CSS remains desktop-native; do not disable zoom or intercept touch scrolling.
export function useEditorViewport(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const viewport = window.visualViewport;
    const mobile = window.matchMedia("(max-width: 760px)");
    let frame = 0;
    function update() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!element) return;
        element.style.setProperty("--editor-visible-height", `${viewport?.height ?? window.innerHeight}px`);
        element.style.setProperty("--editor-visible-top", `${viewport?.offsetTop ?? 0}px`);
        const active = document.activeElement;
        const editing = active instanceof HTMLTextAreaElement || (active instanceof HTMLInputElement && ["text", "number", "search"].includes(active.type));
        element.classList.toggle("keyboard-editing", mobile.matches && editing && element.contains(active));
      });
    }
    update();
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    element.addEventListener("focusin", update);
    element.addEventListener("focusout", update);
    return () => {
      cancelAnimationFrame(frame);
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      element.removeEventListener("focusin", update);
      element.removeEventListener("focusout", update);
    };
  }, [ref]);
}
