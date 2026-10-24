import crypto from "crypto";
import { ScraperUtil } from "../utils/scraper.util.js";

export class BotService {
    constructor(ussClient, aiService) {
        this.uss = ussClient;
        this.ai = aiService;
    }

    async processCourses(courses, isToeic, timeInjectionOnly = false) {
        for (const course of courses) {
            console.log(`\n========================================`);
            console.log(`🚀 PROCESANDO UNIDAD: ${course.Name || course.NodeId}`);
            console.log(`========================================`);

            const tree = await this.uss.getCourseTree(course.NodeId, course.ParentNodeId);
            if (!tree.isSuccess) continue;
            
            const courseId = course.ParentNodeId;
            const unitId = course.NodeId;

            for (const unit of tree.data) {
                const testSection = unit.Children?.find(s => s.Name === "Test");
                
                // Normalizamos la nota para detectar exactamente si ya tiene 100%
                const rawGrade = testSection?.Grade ?? unit.Grade ?? null;
                const numericGrade = rawGrade !== null && rawGrade !== undefined
                    ? (rawGrade <= 1 && rawGrade > 0 ? Math.round(rawGrade * 100) : Math.round(Number(rawGrade)))
                    : null;
                
                // Si la lección no tiene Test (ej. Math Test), basta con que esté IsDone
                if (!testSection && !timeInjectionOnly && (unit.IsDone || unit.Progress === 1.0 || unit.Progress === 100)) {
                    console.log(`\n[✔] Lección (Sin Test): ${unit.Name} -> COMPLETADA (Saltando...)`);
                    continue;
                }

                // OMITIR SI YA TIENE 100%: Solo trabajamos si no tiene nota o si es menor a 100%
                const testNeeds100 = testSection && (numericGrade === null || numericGrade < 100);

                if (!timeInjectionOnly && !testNeeds100 && (unit.IsDone || unit.Progress === 1.0 || unit.Progress === 100)) {
                    console.log(`\n[✔] Lección: ${unit.Name} -> YA TIENE 100% (Saltando...)`);
                    continue;
                }

                console.log(`\n[*] Lección: ${unit.Name} (ID: ${unit.NodeId}) | Nota actual: ${numericGrade ?? "Sin nota"}%`);
                const lessonCode = unit["Metadata"] ? unit["Metadata"]["Code"] : null;
                
                for (const section of unit.Children) {
                    const isTest = section.Name === "Test";
                    const needsTestRepair = isTest && testNeeds100;

                    if (!timeInjectionOnly && !needsTestRepair && (section.IsDone || section.Progress === 1.0 || section.Progress === 100)) {
                        console.log(`  [✔] ${section.Name} -> Listo`);
                        continue;
                    }

                    const lessonSessionId = crypto.randomUUID();
                    const randomMinutes = Math.floor(Math.random() * (14 - 8 + 1)) + 8;

                    await this.uss.setTimeOnLesson(courseId, section.NodeId, lessonSessionId, "S", Date.now());
                    
                    if (timeInjectionOnly) {
                        console.log(`  [⏳] MODO FANTASMA: Simulando ${randomMinutes} min reales en "${section.Name}"...`);
                        for (let i = 0; i < randomMinutes; i++) {
                            await new Promise(r => setTimeout(r, 60000));
                            await this.uss.sendPing(lessonSessionId);
                            console.log(`    [-] Ping de actividad: Minuto ${i+1}/${randomMinutes} validado.`);
                        }
                    } else {
                        if (!isTest) {
                            console.log(`  [>] Completando: ${section.Name}`);
                            for (const task of section.Children) {
                                if (task.IsDone || task.Progress === 1.0) continue;
                                await this.uss.setSucessTask(courseId, task.NodeId);
                                await this.uss.sendPing(lessonSessionId);
                                await new Promise(r => setTimeout(r, 1000));
                            }
                        } else {
                            console.log(`  [!] Buscando el 100% en el Test...`);
                            if (!lessonCode) continue;

                            const testTasks = section.Children && section.Children.length > 0 
                                ? section.Children 
                                : [{ NodeId: section.NodeId, Metadata: { Code: lessonCode } }];

                            await this.resolveFullTest(
                                unitId,
                                unit.NodeId,
                                lessonCode,
                                testTasks,
                                lessonSessionId
                            );
                        }
                    }
                    await this.uss.setTimeOnLesson(courseId, section.NodeId, lessonSessionId, "E", Date.now());
                }
            }
        }
    }

    async resolveFullTest(unitId, lessonNodeId, lessonCode, testTasks, lessonSessionId) {
        try {
            const parsedTasks = [];
            let partCounter = 1;

            // 1. Descargamos todas las partes y aplanamos sus espacios en blanco (slots)
            for (const task of testTasks) {
                const taskCode = task.Metadata?.Code ? task.Metadata.Code : lessonCode;
                const res = await this.uss.getTestItem(taskCode, task.NodeId, lessonNodeId, partCounter);
                
                if (!res.isSuccess) {
                    console.log(`    [!] No se pudo obtener la parte ${partCounter} (${taskCode})`);
                    partCounter++;
                    continue;
                }

                const item = res.data.i || res.data.item || res.data;
                const questions = item.q || item.questions || [];
                const slots = [];
                const sharedPool = !(questions[0]?.al?.[0]?.a?.length > 0); // Detecta si usan banco de palabras compartido (Drag & Drop)

                for (const q of questions) {
                    if (q.al && q.al.length > 0) {
                        for (const blank of q.al) {
                            let rawOptions = [];
                            if (blank.a && blank.a.length > 0) rawOptions.push(...blank.a);
                            else if (item.d && item.d.length > 0) rawOptions.push(...item.d);
                            else if (q.d && q.d.length > 0) rawOptions.push(...q.d);

                            const options = rawOptions.map(opt => ({ id: opt.id }));

                            slots.push({
                                qId: q.id,
                                blankId: blank.id,
                                options,
                                currentIndex: 0,
                                bestIndex: 0,
                                lockedSlot: false
                            });
                        }
                    }
                }

                // Si es un banco compartido (Drag & Drop), iniciamos cada espacio con una palabra distinta (0, 1, 2...)
                if (sharedPool && slots.length > 1) {
                    slots.forEach((s, idx) => {
                        if (s.options.length > 0) {
                            s.currentIndex = idx % s.options.length;
                            s.bestIndex = s.currentIndex;
                        }
                    });
                }

                parsedTasks.push({
                    nodeId: String(task.NodeId),
                    matchedCode: res.matchedCode,
                    matchedType: String(res.matchedType || "25"),
                    partCounter,
                    sharedPool,
                    slots,
                    bestScore: 0,
                    activeSlotIdx: 0, // Qué espacio estamos rotando actualmente en Hill-Climbing
                    slotTries: 0,
                    fullySolved: false
                });

                partCounter++;
            }

            if (parsedTasks.length === 0) return;

            // 2. BUCLE HILL-CLIMBING HASTA CONSEGUIR 100%
            const maxAttempts = 60; // Margen amplio para no rendirse en preguntas compuestas
            let currentMark = 0;

            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                const submitAnswer = [];

                for (const pt of parsedTasks) {
                    // Agrupamos los slots de vuelta por su qId original
                    const qMap = new Map();
                    for (const s of pt.slots) {
                        if (!qMap.has(s.qId)) qMap.set(s.qId, []);
                        const chosenOpt = s.options[s.currentIndex] || { id: 1 };
                        qMap.get(s.qId).push([s.blankId, chosenOpt.id]);
                    }

                    const userAnswersForTask = [];
                    for (const [qId, aIdArray] of qMap.entries()) {
                        userAnswersForTask.push({ qId, aId: aIdArray });
                    }

                    submitAnswer.push({
                        iId: pt.nodeId,
                        iCode: pt.matchedCode,
                        iType: pt.matchedType,
                        ua: userAnswersForTask
                    });
                }

                const safeTimeMs = Math.floor(Math.random() * (31500 - 20000 + 1)) + 20000;
                const status = await this.uss.SaveUserTestV1(unitId, lessonNodeId, submitAnswer, safeTimeMs);

                if (!status.isSuccess || !status.data) {
                    console.log(`    [!] Error en intento ${attempt}: ${status.error}`);
                    break;
                }

                currentMark = status.data.finalMark ?? 0;
                const marksArray = status.data.marks || [];

                // Si ya logramos el 100% global, salimos victoriosos inmediatamente
                if (currentMark >= 100) {
                    console.log(`    [🎯] Intento ${attempt}: Nota = 100%`);
                    console.log(`    [#] ¡100% CONSEGUIDO PERFECTAMENTE en ${attempt} intentos!`);
                    break;
                }

                let solvedPartsCount = 0;

                for (const pt of parsedTasks) {
                    if (pt.fullySolved || pt.slots.length === 0) {
                        solvedPartsCount++;
                        continue;
                    }

                    const markObj = marksArray.find(m => String(m.iId) === pt.nodeId);
                    const score = markObj ? Number(markObj.m) : 0;

                    // CASO A: Pregunta de 1 solo espacio (Opción múltiple normal)
                    if (pt.slots.length === 1) {
                        const s = pt.slots[0];
                        if (score > 0) {
                            pt.bestScore = score;
                            s.bestIndex = s.currentIndex;
                            pt.fullySolved = true;
                            solvedPartsCount++;
                        } else {
                            if (s.options.length > 0) {
                                s.currentIndex = (s.currentIndex + 1) % s.options.length;
                            }
                        }
                    } 
                    // CASO B: Pregunta compuesta (Múltiples espacios / Drag & Drop / Emparejamiento)
                    else {
                        if (attempt === 1) {
                            pt.bestScore = score;
                            pt.slots.forEach(s => { s.bestIndex = s.currentIndex; });
                        } else {
                            if (score > pt.bestScore) {
                                // ¡Subió el puntaje de esta parte! Guardamos este estado como la nueva base
                                pt.bestScore = score;
                                pt.slots.forEach(s => { s.bestIndex = s.currentIndex; });
                                pt.slots[pt.activeSlotIdx].lockedSlot = true;
                                pt.activeSlotIdx = (pt.activeSlotIdx + 1) % pt.slots.length;
                                pt.slotTries = 0;
                            } else if (score < pt.bestScore) {
                                // Si al mover este espacio el puntaje bajó, significa que el valor anterior ERA EL CORRECTO
                                pt.slots.forEach(s => { s.currentIndex = s.bestIndex; });
                                pt.slots[pt.activeSlotIdx].lockedSlot = true;
                                pt.activeSlotIdx = (pt.activeSlotIdx + 1) % pt.slots.length;
                                pt.slotTries = 0;
                            }
                        }

                        // Si todos los espacios individuales ya quedaron verificados, damos la parte por resuelta
                        if (pt.slots.every(s => s.lockedSlot)) {
                            pt.fullySolved = true;
                            solvedPartsCount++;
                            continue;
                        }

                        // Buscamos el siguiente espacio no bloqueado para probar la siguiente opción
                        while (pt.slots[pt.activeSlotIdx].lockedSlot) {
                            pt.activeSlotIdx = (pt.activeSlotIdx + 1) % pt.slots.length;
                        }

                        const activeSlot = pt.slots[pt.activeSlotIdx];
                        pt.slotTries++;

                        // Si dimos toda la vuelta a las opciones de este espacio sin que cambie el puntaje
                        // (ocurre cuando el servidor evalúa "todo o nada" en un par de espacios), rotamos el siguiente también
                        if (pt.slotTries >= activeSlot.options.length) {
                            pt.slotTries = 0;
                            const nextIdx = (pt.activeSlotIdx + 1) % pt.slots.length;
                            const nextSlot = pt.slots[nextIdx];
                            if (nextSlot.options.length > 0) {
                                nextSlot.currentIndex = (nextSlot.currentIndex + 1) % nextSlot.options.length;
                                nextSlot.bestIndex = nextSlot.currentIndex;
                            }
                        }

                        if (activeSlot.options.length > 0) {
                            activeSlot.currentIndex = (activeSlot.currentIndex + 1) % activeSlot.options.length;

                            // Si es Drag & Drop compartido, evitamos elegir un ID que ya esté bloqueado en otro espacio
                            if (pt.sharedPool) {
                                const lockedIds = new Set(
                                    pt.slots.filter((s, idx) => idx !== pt.activeSlotIdx && s.lockedSlot)
                                            .map(s => s.options[s.bestIndex]?.id)
                                );
                                let guard = 0;
                                while (lockedIds.has(activeSlot.options[activeSlot.currentIndex]?.id) && guard < activeSlot.options.length) {
                                    activeSlot.currentIndex = (activeSlot.currentIndex + 1) % activeSlot.options.length;
                                    guard++;
                                }
                            }
                        }
                    }
                }

                console.log(`    [🎯] Intento ${attempt}: Nota = ${currentMark}% (${solvedPartsCount}/${parsedTasks.length} partes al 100%)`);

                if ( attempt % 4 === 0 ) {
                    await this.uss.sendPing(lessonSessionId);
                }
                await new Promise(r => setTimeout(r, 600)); // Pausa ágil de 0.6s entre intentos
            }

            if (currentMark < 100) {
                console.log(`    [!] Se alcanzó el límite de intentos. Mejor nota obtenida: ${currentMark}%`);
            }

        } catch (e) {
            console.log(`    [!] Error en Test:`, e.message);
        }
    }
}