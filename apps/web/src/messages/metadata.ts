import type { Lang } from "@/lib/domain/contracts";

interface MetadataCopy {
  readonly landingTitle: string;
  readonly landingDescription: string;
  readonly liveNetworkTitle: string;
  readonly liveNetworkDescription: string;
  readonly liveLineDescription: string;
  readonly liveStationDescription: string;
  readonly historyNetworkTitle: string;
  readonly historyNetworkDescription: string;
  readonly historyLineDescription: string;
  readonly historyStationDescription: string;
  readonly methodologyTitle: string;
  readonly methodologyDescription: string;
}

export const metadataCopy: Readonly<Record<Lang, MetadataCopy>> = {
  es: {
    landingTitle: "Andén Infinito · Evidencia de Cercanías Madrid",
    landingDescription: "Consulta el estado actual y el histórico de puntualidad, retrasos y cobertura de Cercanías Madrid a partir de evidencia pública de Renfe.",
    liveNetworkTitle: "Cercanías Madrid en directo",
    liveNetworkDescription: "Estado actual de Cercanías Madrid: trenes activos con evidencia fresca, retrasos, cobertura y detalle por línea.",
    liveLineDescription: "Estado en directo, trenes activos, esquema y matriz diaria de la línea {context} de Cercanías Madrid.",
    liveStationDescription: "Estado en directo y trenes con evidencia fresca en {context}, Cercanías Madrid.",
    historyNetworkTitle: "Histórico de Cercanías Madrid",
    historyNetworkDescription: "Analiza puntualidad, retrasos, cobertura, peores estaciones y horas de Cercanías Madrid.",
    historyLineDescription: "Histórico de puntualidad, retrasos, estaciones, tramos y cobertura de la línea {context} de Cercanías Madrid.",
    historyStationDescription: "Histórico de puntualidad, retrasos, volumen y cobertura en {context}, Cercanías Madrid.",
    methodologyTitle: "Metodología",
    methodologyDescription: "Cómo Andén Infinito interpreta horarios y evidencia pública de Renfe, calcula retrasos y expresa cobertura, incertidumbre y retención.",
  },
  en: {
    landingTitle: "Andén Infinito · Madrid Cercanías evidence",
    landingDescription: "Explore current and historical punctuality, delay and coverage for Madrid Cercanías using public Renfe evidence.",
    liveNetworkTitle: "Madrid Cercanías live",
    liveNetworkDescription: "Current Madrid Cercanías status: active trains with fresh evidence, delays, coverage and line-level detail.",
    liveLineDescription: "Live status, active trains, schematic and daily matrix for Madrid Cercanías line {context}.",
    liveStationDescription: "Live status and trains with fresh evidence at {context}, Madrid Cercanías.",
    historyNetworkTitle: "Madrid Cercanías history",
    historyNetworkDescription: "Explore punctuality, delays, coverage, worst stations and worst hours across Madrid Cercanías.",
    historyLineDescription: "Historical punctuality, delays, stations, segments and coverage for Madrid Cercanías line {context}.",
    historyStationDescription: "Historical punctuality, delays, volume and coverage at {context}, Madrid Cercanías.",
    methodologyTitle: "Methodology",
    methodologyDescription: "How Andén Infinito interprets Renfe public timetable and realtime evidence, calculates delay and represents coverage, uncertainty and retention.",
  },
};

export function contextDescription(template: string, context: string): string {
  return template.replace("{context}", context);
}
