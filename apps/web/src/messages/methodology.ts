import type { Lang } from "@/lib/domain/contracts";

interface MethodSection { readonly title: string; readonly paragraphs: readonly string[] }
interface MethodCopy { readonly kicker: string; readonly title: string; readonly intro: string; readonly sections: readonly MethodSection[] }

export const methodologyCopy: Readonly<Record<Lang, MethodCopy>> = {
  es: {
    kicker: "Evidencia antes que precisión falsa",
    title: "Cómo medimos Cercanías",
    intro: "Atodotren transforma datos públicos de Renfe en una historia acumulada del servicio. Separa lo reportado, lo calculado y lo que sencillamente no puede saberse con la evidencia disponible.",
    sections: [
      { title: "Fuentes", paragraphs: ["Usamos el GTFS estático de Renfe para horarios, recorridos y estaciones, y GTFS-Realtime para actualizaciones de viaje, posiciones de vehículo y alertas. El navegador nunca consulta estas fuentes ni la base de datos directamente: el servidor publica modelos de lectura acotados."] },
      { title: "Retraso reportado y calculado", paragraphs: ["Renfe puede informar una hora estimada de llegada y/o un retraso en segundos. Cuando existe una hora de llegada correctamente enlazada con el horario, calculamos su desviación y conservamos también el retraso proporcionado por Renfe. Las discrepancias no se borran.", "Consideramos puntual una llegada con retraso de 120 segundos o menos. El sistema conserva segundos enteros y redondea solo para mostrar resultados."] },
      { title: "Predicciones, presencia y posición", paragraphs: ["Un retraso propagado desde una parada anterior sirve únicamente como predicción en directo: nunca se convierte en evidencia histórica de una parada posterior. STOPPED_AT se interpreta como presencia observada en la parada en ese instante, no como una hora de llegada exacta.", "El mapa en directo es esquemático. Cuando situamos un tren entre estaciones a partir del estado del feed, lo etiquetamos como posición inferida. No representa coordenadas GPS ni precisión geográfica."] },
      { title: "Cancelaciones y huecos", paragraphs: ["Las paradas canceladas, omitidas y sin evidencia se mantienen como estados distintos y se excluyen de la distribución de retrasos. La desaparición de un viaje no se interpreta automáticamente como cancelación. La cobertura indica qué parte de las oportunidades programadas dispone de evidencia utilizable."] },
      { title: "Días incompletos y cierre", paragraphs: ["El día de servicio no termina necesariamente a medianoche. Los datos del día actual pueden estar incompletos y se identifican como no finalizados. Tras el cierre y las comprobaciones de consistencia, los agregados quedan sellados para esa versión del algoritmo."] },
      { title: "Agregación y retención", paragraphs: ["El detalle reconstruible de cada viaje y la matriz exacta se conserva durante 30 días de servicio completados. Después permanecen agregados diarios por hora y agregados mensuales por horario programado, diseñados para combinarse sin fingir que existe detalle que ya no se conserva."] },
      { title: "Propósito", paragraphs: ["Atodotren es una herramienta independiente de rendición de cuentas pública. Su objetivo no es explicar por qué ocurrió cada retraso, sino conservar una evidencia comprensible de cuánto, dónde y con qué cobertura se produjo."] },
    ],
  },
  en: {
    kicker: "Evidence before false precision",
    title: "How we measure Cercanías",
    intro: "Atodotren turns Renfe public data into an accumulated record of service performance. It keeps reported, calculated and unknowable facts distinct instead of smoothing those differences away.",
    sections: [
      { title: "Sources", paragraphs: ["We use Renfe static GTFS for timetables, routes and stations, and GTFS-Realtime for trip updates, vehicle positions and alerts. The browser never queries those feeds or PostgreSQL directly: the server exposes bounded read models."] },
      { title: "Reported and calculated delay", paragraphs: ["Renfe may provide an estimated arrival timestamp and/or delay in seconds. When an arrival timestamp can be reliably matched to schedule, we calculate its deviation while preserving Renfe’s provided delay separately. Discrepancies are retained rather than silently reconciled.", "A call is punctual at 120 seconds of delay or less. The system stores integer seconds and rounds only for presentation."] },
      { title: "Predictions, presence and position", paragraphs: ["Delay propagated from an upstream stop is a live prediction only; it never becomes historical evidence for a later stop. STOPPED_AT is treated as observed presence at a stop at that instant, not an exact arrival timestamp.", "The live map is schematic. When a train is placed between stations from feed state, it is explicitly labelled inferred. It is neither GPS nor a claim of geographic precision."] },
      { title: "Cancellations and gaps", paragraphs: ["Canceled, skipped and missing-evidence calls remain separate states and are excluded from delay distributions. A journey disappearing from the feed is not automatically a cancellation. Coverage tells you how much of the scheduled denominator has usable evidence."] },
      { title: "Incomplete days and finalization", paragraphs: ["A service day does not necessarily end at civil midnight. Current-day values can be incomplete and are marked unfinalized. After the service day closes and consistency checks pass, aggregates are sealed for that algorithm version."] },
      { title: "Aggregation and retention", paragraphs: ["Reconstructable journey detail and exact timetable matrices are retained for 30 completed service days. After that, daily hourly aggregates and monthly scheduled-slot aggregates remain, designed to combine correctly without pretending old train-level detail still exists."] },
      { title: "Purpose", paragraphs: ["Atodotren is an independent public-accountability tool. It does not claim to explain the cause of each delay; it preserves understandable evidence of how much delay occurred, where it accumulated and how complete the underlying evidence was."] },
    ],
  },
};
