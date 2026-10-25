import { Ship, Shield, Radio, Home, Cast, type LucideIcon } from 'lucide-react'

export type ProviderType = 'onvif' | 'hikvision' | 'reolink' | 'homeAssistant' | 'rtsp'

export const providerIcons: Record<ProviderType, LucideIcon> = {
  onvif: Ship,
  hikvision: Shield,
  reolink: Radio,
  homeAssistant: Home,
  rtsp: Cast,
}
