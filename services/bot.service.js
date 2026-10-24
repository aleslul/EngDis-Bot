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

    // Genera todas las combinaciones válidas para una parte del Test
    buildCandidateAnswers(questions, item) {
        const slots = [];
        const globalPool = [
            ...(item.d || []),
            ...(item.al || []),
            ...(item.choices || [])
        ];

        for (const q of questions) {
            const qPool = [...(q.d || []), ...(q.a || []), ...globalPool];
            const alList = q.al && q.al.length > 0 ? q.al : [{ id: 1, a: qPool }];

            for (const blank of alList) {
                let rawOpts = [];
                if (blank.a && blank.a.length > 0) rawOpts = blank.a;
                else if (qPool.length > 0) rawOpts = qPool;

                const optIds = [...new Set(rawOpts.map(o => o.id).filter(id => id !== undefined))];
                if (optIds.length === 0) optIds.push(1, 2, 3, 4);

                slots.push({
                    qId: q.id || 1,
                    blankId: blank.id || 1,
                    optIds,
                    hasOwnOptions: Boolean(blank.a && blank.a.length > 0)
                });
            }
        }

        if (slots.length === 0) return [[]];

        const formatUa = (assignment) => {
            const qMap = new Map();
            assignment.forEach((choice, idx) => {
                const s = slots[idx];
                if (!qMap.has(s.qId)) qMap.set(s.qId, []);
                if (Array.isArray(choice)) {
                    // Caso Checkbox múltiple (2 respuestas en el mismo blankId)
                    choice.forEach(cId => qMap.get(s.qId).push([s.blankId, cId]));
                } else {
                    qMap.get(s.qId).push([s.blankId, choice]);
                }
            });
            const ua = [];
            for (const [qId, aId] of qMap.entries()) ua.push({ qId, aId });
            return ua;
        };

        const candidates = [];

        // CASO 1: Un solo espacio (Opción múltiple simple o Checkbox de elegir 2)
        if (slots.length === 1) {
            const opts = slots[0].optIds;
            // Primero probamos selección simple (1 opción)
            for (const id of opts) {
                candidates.push(formatUa([id]));
            }
            // Si ninguna de 1 opción funcionó, probamos pares de 2 opciones (Checkboxes múltiples)
            for (let i = 0; i < opts.length; i++) {
                for (let j = i + 1; j < opts.length; j++) {
                    candidates.push(formatUa([[opts[i], opts[j]]]));
                }
            }
            return candidates;
        }

        // CASO 2: Múltiples espacios (Drag & Drop / Matching / Fill in blanks)
        const sharedPool = slots.every(s => !s.hasOwnOptions);

        const backtrack = (slotIdx, currentAssignment, usedSet) => {
            if (candidates.length >= 120) return; // Límite de seguridad
            if (slotIdx === slots.length) {
                candidates.push(formatUa(currentAssignment));
                return;
            }
            const opts = slots[slotIdx].optIds;
            for (const id of opts) {
                // En Drag & Drop con banco compartido, no repetimos la misma palabra en dos casillas
                if (sharedPool && opts.length >= slots.length && usedSet.has(id)) continue;
                currentAssignment.push(id);
                usedSet.add(id);
                backtrack(slotIdx + 1, currentAssignment, usedSet);
                currentAssignment.pop();
                usedSet.delete(id);
            }
        };

        backtrack(0, [], new Set());

        // Si por alguna razón una palabra sí se repetía, agregamos el producto cartesiano al final
        if (sharedPool && candidates.length < 60) {
            const backtrackWithRepeat = (slotIdx, currentAssignment) => {
                if (candidates.length >= 120) return;
                if (slotIdx === slots.length) {
                    candidates.push(formatUa(currentAssignment));
                    return;
                }
                for (const id of slots[slotIdx].optIds) {
                    currentAssignment.push(id);
                    backtrackWithRepeat(slotIdx + 1, currentAssignment);
                    currentAssignment.pop();
                }
            };
            backtrackWithRepeat(0, []);
        }

        return candidates.length > 0 ? candidates : [[]];
    }

    // Extrae todos los espacios en blanco (slots) de una parte del Test
    extractSlotsFromItem(questions, item) {
        const slots = [];
        const globalPool = [
            ...(item.d || []),
            ...(item.al || []),
            ...(item.choices || [])
        ];

        for (const q of questions) {
            const qPool = [...(q.d || []), ...(q.a || []), ...globalPool];
            const alList = q.al && q.al.length > 0 ? q.al : [{ id: 1, a: qPool }];

            for (const blank of alList) {
                let rawOpts = [];
                if (blank.a && blank.a.length > 0) rawOpts = blank.a;
                else if (qPool.length > 0) rawOpts = qPool;

                const optIds = [...new Set(rawOpts.map(o => o.id).filter(id => id !== undefined && id !== null))];
                if (optIds.length === 0) optIds.push(1, 2, 3, 4);

                slots.push({
                    qId: q.id ?? 1,
                    blankId: blank.id ?? 1,
                    optIds,
                    hasOwnOptions: Boolean(blank.a && blank.a.length > 0),
                    currentIndex: 0,
                    bestIndex: 0,
                    slotLocked: false
                });
            }
        }

        const sharedPool = slots.length > 1 && slots.every(s => !s.hasOwnOptions);

        // Si comparten banco de palabras, inicializamos sin repetir IDs (0, 1, 2...)
        if (sharedPool) {
            slots.forEach((s, idx) => {
                s.currentIndex = idx % s.optIds.length;
                s.bestIndex = s.currentIndex;
            });
        }

        return { slots, sharedPool };
    }

    // Construye el arreglo "ua" a partir del estado actual de los slots
    buildUaFromSlots(pt) {
        if (pt.multiChoicePairMode && pt.pairCandidates && pt.pairCandidates.length > 0) {
            return pt.pairCandidates[pt.pairIdx % pt.pairCandidates.length];
        }

        const qMap = new Map();
        for (const s of pt.slots) {
            if (!qMap.has(s.qId)) qMap.set(s.qId, []);
            const chosenId = s.optIds[s.currentIndex] ?? s.optIds[0] ?? 1;
            qMap.get(s.qId).push([s.blankId, chosenId]);
        }

        const ua = [];
        for (const [qId, aId] of qMap.entries()) {
            ua.push({ qId, aId });
        }
        return ua;
    }

    async resolveFullTest(unitId, lessonNodeId, lessonCode, testTasks, lessonSessionId) {
        try {
            const parsedTasks = [];
            let partCounter = 1;

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
                const { slots, sharedPool } = this.extractSlotsFromItem(questions, item);

                // Detectamos el iType real: si es Drag & Drop / banco compartido o múltiples espacios suele ser "23", si es opción múltiple simple es "25"
                const metaType = task.Metadata?.ItemType || task.ItemType || item.iType;
                let initialType = String(metaType || res.matchedType || "25");
                if (!metaType && (sharedPool || slots.length > 1 || (item.d && item.d.length > 0))) {
                    initialType = "23";
                }

                // Preparamos candidatos de pares por si una pregunta de 1 slot es Checkbox de "Elige 2 respuestas"
                const pairCandidates = [];
                if (slots.length === 1 && slots[0].optIds.length >= 3) {
                    const s = slots[0];
                    for (let i = 0; i < s.optIds.length; i++) {
                        for (let j = i + 1; j < s.optIds.length; j++) {
                            pairCandidates.push([{
                                qId: s.qId,
                                aId: [[s.blankId, s.optIds[i]], [s.blankId, s.optIds[j]]]
                            }]);
                        }
                    }
                }

                parsedTasks.push({
                    nodeId: String(task.NodeId),
                    matchedCode: res.matchedCode,
                    matchedType: initialType,
                    altTypes: ["25", "23", "24", "21", "20"].filter(t => t !== initialType),
                    partCounter,
                    slots,
                    sharedPool,
                    bestScore: 0,
                    locked: false,
                    // Variables para resolución fina (Fase 2)
                    activeSlotIdx: 0,
                    probeStep: 0,
                    multiChoicePairMode: false,
                    pairCandidates,
                    pairIdx: 0,
                    odometerStep: 0
                });

                partCounter++;
            }

            if (parsedTasks.length === 0) return;

            const maxSingleOptions = Math.max(...parsedTasks.map(pt => pt.slots[0]?.optIds.length || 4), 4);
            const maxAttempts = 85;
            let currentMark = 0;

            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                const submitAnswer = parsedTasks.map(pt => ({
                    iId: pt.nodeId,
                    iCode: pt.matchedCode,
                    iType: pt.matchedType,
                    ua: this.buildUaFromSlots(pt)
                }));

                const safeTimeMs = Math.floor(Math.random() * (31500 - 20000 + 1)) + 20000;
                const status = await this.uss.SaveUserTestV1(unitId, lessonNodeId, submitAnswer, safeTimeMs);

                if (!status.isSuccess || !status.data) {
                    console.log(`    [!] Error en intento ${attempt}: ${status.error}`);
                    break;
                }

                currentMark = status.data.finalMark ?? 0;
                const marksArray = status.data.marks || [];

                if (currentMark >= 100) {
                    console.log(`    [🎯] Intento ${attempt}: Nota = 100%`);
                    console.log(`    [#] ¡100% CONSEGUIDO PERFECTAMENTE en ${attempt} intentos!`);
                    break;
                }

                // Determinamos si el servidor reporta m en escala 0..100 o 0..1
                const maxObservedM = Math.max(...marksArray.map(m => Number(m.m) || 0), 0);
                const fullPartThreshold = maxObservedM > 1 ? 99 : 1;

                let lockedCount = 0;

                for (const pt of parsedTasks) {
                    if (pt.locked || pt.slots.length === 0) {
                        lockedCount++;
                        continue;
                    }

                    const markObj = marksArray.find(m => String(m.iId) === pt.nodeId);
                    const score = markObj ? Number(markObj.m) : 0;

                    // 1. ¿Esta parte ya alcanzó su puntaje perfecto (100)?
                    if (score >= fullPartThreshold && score > 0) {
                        pt.bestScore = score;
                        pt.slots.forEach(s => { s.bestIndex = s.currentIndex; s.slotLocked = true; });
                        pt.locked = true;
                        lockedCount++;
                        continue;
                    }

                    // =========================================================================
                    // CASO A: Pregunta de 1 solo espacio (Opción Múltiple o Checkbox Doble)
                    // =========================================================================
                    if (pt.slots.length === 1) {
                        const s = pt.slots[0];

                        // Si dio algún punto positivo en pregunta de 1 espacio y no estamos en modo pares, es la correcta
                        if (score > 0 && !pt.multiChoicePairMode) {
                            pt.bestScore = score;
                            s.bestIndex = s.currentIndex;
                            pt.locked = true;
                            lockedCount++;
                            continue;
                        }

                        if (!pt.multiChoicePairMode) {
                            if (s.currentIndex + 1 < s.optIds.length) {
                                s.currentIndex++;
                            } else {
                                // Ya probamos todas las opciones individuales y dio 0:
                                // Probamos cambiar entre iType "25" y "23", o pasamos a modo Checkbox de 2 respuestas
                                if (pt.altTypes.length > 0 && pt.probeStep === 0) {
                                    pt.matchedType = pt.altTypes.shift();
                                    s.currentIndex = 0;
                                    pt.probeStep = 1;
                                } else if (pt.pairCandidates.length > 0) {
                                    pt.multiChoicePairMode = true;
                                    pt.pairIdx = 0;
                                } else {
                                    s.currentIndex = s.bestIndex;
                                    pt.locked = true;
                                    lockedCount++;
                                }
                            }
                        } else {
                            // Estamos probando pares de Checkboxes (2 respuestas)
                            if (score > pt.bestScore) {
                                pt.bestScore = score;
                                if (score >= fullPartThreshold) {
                                    pt.locked = true;
                                    lockedCount++;
                                    continue;
                                }
                            }
                            if (pt.pairIdx + 1 < pt.pairCandidates.length) {
                                pt.pairIdx++;
                            } else {
                                pt.locked = true;
                                lockedCount++;
                            }
                        }
                    }
                    // =========================================================================
                    // CASO B: Pregunta de MÚLTIPLES espacios (Drag & Drop / Cloze / Matching)
                    // =========================================================================
                    else {
                        if (attempt === 1) {
                            pt.bestScore = score;
                            pt.slots.forEach(s => { s.bestIndex = s.currentIndex; });
                        } else {
                            if (score > pt.bestScore) {
                                // ¡Subió la nota de esta parte! Guardamos la mejora y bloqueamos el slot que probábamos
                                pt.bestScore = score;
                                pt.slots.forEach(s => { s.bestIndex = s.currentIndex; });
                                pt.slots[pt.activeSlotIdx].slotLocked = true;
                                pt.probeStep = 0;
                            } else if (score < pt.bestScore) {
                                // ¡Bajó la nota al mover este slot! Eso demuestra al 100% que el bestIndex anterior era el correcto
                                pt.slots.forEach(s => { s.currentIndex = s.bestIndex; });
                                pt.slots[pt.activeSlotIdx].slotLocked = true;
                                pt.probeStep = 0;
                            }
                        }

                        // Si todos los slots quedaron confirmados pero aún no llega a 100, desbloqueamos los que no subieron nota
                        if (pt.slots.every(s => s.slotLocked)) {
                            pt.slots.forEach(s => { s.slotLocked = false; });
                            // Si estaba en 0 total, probamos alternar el iType ("23" <-> "25")
                            if (pt.bestScore === 0 && pt.altTypes.length > 0) {
                                pt.matchedType = pt.altTypes.shift();
                            }
                        }

                        // Buscamos el primer slot no bloqueado
                        let safety = 0;
                        while (pt.slots[pt.activeSlotIdx].slotLocked && safety < pt.slots.length) {
                            pt.activeSlotIdx = (pt.activeSlotIdx + 1) % pt.slots.length;
                            safety++;
                        }

                        const activeSlot = pt.slots[pt.activeSlotIdx];
                        pt.probeStep++;

                        // Si ya probamos todas las opciones de este slot y la nota sigue clavada en 0
                        // (significa que el servidor evalúa "Todo o Nada"), avanzamos en modo permutación sin repetición
                        if (pt.probeStep >= activeSlot.optIds.length) {
                            pt.probeStep = 0;
                            if (pt.bestScore > 0) {
                                // Restauramos el mejor conocido y pasamos al siguiente slot
                                activeSlot.currentIndex = activeSlot.bestIndex;
                                pt.activeSlotIdx = (pt.activeSlotIdx + 1) % pt.slots.length;
                            } else {
                                // Modo Todo o Nada (bestScore === 0): rotamos el siguiente slot tipo odómetro sin repetir IDs
                                pt.odometerStep++;
                                let temp = pt.odometerStep;
                                const usedIds = new Set();
                                for (let i = 0; i < pt.slots.length; i++) {
                                    const s = pt.slots[i];
                                    const len = s.optIds.length;
                                    let idx = temp % len;
                                    temp = Math.floor(temp / len);
                                    if (pt.sharedPool && len >= pt.slots.length) {
                                        let guard = 0;
                                        while (usedIds.has(s.optIds[idx]) && guard < len) {
                                            idx = (idx + 1) % len;
                                            guard++;
                                        }
                                        usedIds.add(s.optIds[idx]);
                                    }
                                    s.currentIndex = idx;
                                    s.bestIndex = idx;
                                }
                                continue;
                            }
                        }

                        // Avanzamos a la siguiente opción en el slot activo
                        const nextSlot = pt.slots[pt.activeSlotIdx];
                        nextSlot.currentIndex = (nextSlot.currentIndex + 1) % nextSlot.optIds.length;

                        // Si es Drag & Drop con banco compartido, evitamos elegir un ID que ya esté bloqueado en otro slot
                        if (pt.sharedPool) {
                            const lockedIds = new Set(
                                pt.slots
                                    .filter((s, idx) => idx !== pt.activeSlotIdx && s.slotLocked)
                                    .map(s => s.optIds[s.bestIndex])
                            );
                            let guard = 0;
                            while (lockedIds.has(nextSlot.optIds[nextSlot.currentIndex]) && guard < nextSlot.optIds.length) {
                                nextSlot.currentIndex = (nextSlot.currentIndex + 1) % nextSlot.optIds.length;
                                guard++;
                            }
                        }
                    }
                }

                // Log detallado: muestra el puntaje individual [m] de cada parte para ver cuál se resiste
                const detailMarks = parsedTasks.map(pt => {
                    const mObj = marksArray.find(m => String(m.iId) === pt.nodeId);
                    return `P${pt.partCounter}:${mObj ? mObj.m : 0}`;
                }).join(' | ');

                console.log(`    [🎯] Intento ${attempt}: Nota = ${currentMark}% [${detailMarks}]`);

                if (lockedCount === parsedTasks.length && currentMark < 100) {
                    console.log(`    [!] Partes agotadas. Nota alcanzada: ${currentMark}%`);
                    break;
                }

                if (attempt % 5 === 0) await this.uss.sendPing(lessonSessionId);
                await new Promise(r => setTimeout(r, 500));
            }
        } catch (e) {
            console.log(`    [!] Error en Test:`, e.message);
        }
    }
}