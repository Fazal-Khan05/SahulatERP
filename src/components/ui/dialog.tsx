"use client";
import { useRef, useState, type RefObject } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
export const Dialog=DialogPrimitive.Root;
export const DialogTrigger=DialogPrimitive.Trigger;
export const DialogTitle=DialogPrimitive.Title;
export const DialogDescription=DialogPrimitive.Description;
// Dialogs here open from state, not Dialog.Trigger, so Radix has no trigger to return focus to and drops it on <body>.
// RememberFocus mounts with the content and records what had focus when the dialog opened (during render, before any
// autoFocus field inside takes it); closing returns focus there while that element is still on the page.
function RememberFocus({into}:{into:RefObject<HTMLElement|null>}){useState(()=>{const active=typeof document==="undefined"?null:document.activeElement;into.current=active instanceof HTMLElement&&active!==document.body?active:null;});return null;}
export function DialogContent({children,className,onCloseAutoFocus,...props}:React.ComponentProps<typeof DialogPrimitive.Content>){const returnTo=useRef<HTMLElement|null>(null);return <DialogPrimitive.Portal><DialogPrimitive.Overlay className="dialog-overlay"/><DialogPrimitive.Content className={cn("dialog-content",className)} onCloseAutoFocus={event=>{onCloseAutoFocus?.(event);const target=returnTo.current;if(event.defaultPrevented||!target?.isConnected)return;event.preventDefault();target.focus();}} {...props}><RememberFocus into={returnTo}/>{children}<DialogPrimitive.Close className="dialog-close" aria-label="Close dialog"><X size={18}/></DialogPrimitive.Close></DialogPrimitive.Content></DialogPrimitive.Portal>;}
