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
            
            const courseId = course.ParentNodeId; // Ej: 44845 (Intermediate 1)
            const unitId = course.NodeId;         // Ej: 44846 (Unit 1: Education)

            for (const unit of tree.data) {
                const testSection = unit.Children?.find(s => s.Name === "Test");
                
                // Normalizamos la nota (a veces viene de 0 a 1, y a veces de 0 a 100)
                const rawGrade = testSection?.Grade ?? unit.Grade ?? null;
                const numericGrade = rawGrade !== null ? (rawGrade <= 1 && rawGrade > 0 ? rawGrade * 100 : Number(rawGrade)) : null;
                
                // Si no tiene nota, o si la nota es menor a 80%, entramos a resolverlo de nuevo
                const testNeedsWork = testSection && (numericGrade === null || numericGrade < 80);

                if (!timeInjectionOnly && !testNeedsWork && (unit.IsDone || unit.Progress === 1.0 || unit.Progress === 100)) {
                    console.log(`\n[✔] Lección: ${unit.Name} -> COMPLETADA CON NOTA (${numericGrade}%) (Saltando...)`);
                    continue;
                }

                console.log(`\n[*] Lección: ${unit.Name} (ID: ${unit.NodeId})`);
                const lessonCode = unit["Metadata"] ? unit["Metadata"]["Code"] : null;
                let contextText = "";
                
                if (lessonCode && !timeInjectionOnly) {
                    contextText = await ScraperUtil.getContext(lessonCode);
                    if (contextText) console.log(`    [#] Contexto extraído con éxito.`);
                }
                
                for (const section of unit.Children) {
                    const isTest = section.Name === "Test";
                    const needsTestRepair = isTest && testNeedsWork;

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
                            console.log(`  [!] Iniciando Oráculo para el Test completo...`);
                            if (!lessonCode) continue;

                            const testTasks = section.Children && section.Children.length > 0 
                                ? section.Children 
                                : [{ NodeId: section.NodeId, Metadata: { Code: lessonCode } }];

                            // Resolvemos TODAS las partes del Test y las enviamos en UN SOLO POST
                            await this.resolveFullTest(
                                unitId,         // 44846 (ID de la Unidad Padre)
                                unit.NodeId,    // 38 (ID de la Lección)
                                lessonCode,     // Ej: "i1rack"
                                testTasks,      // Array con las tareas [23875, 23876, ...]
                                contextText, 
                                lessonSessionId
                            );
                        }
                    }
                    await this.uss.setTimeOnLesson(courseId, section.NodeId, lessonSessionId, "E", Date.now());
                }
            }
        }
    }

    async resolveFullTest(unitId, lessonNodeId, lessonCode, testTasks, contextText, lessonSessionId) {
        try {
            const parsedTasks = [];
            const batchForAi = [];
            let partCounter = 1;
            let batchKeyCounter = 0;

            // 1. Descargamos todas las preguntas del Test rápidamente
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
                const taskQuestionsMeta = [];

                for (const q of questions) {
                    const rawQuestion = q.qt || (typeof q.t === 'string' ? q.t : null) || q.d || "Complete the blank correctly.";
                    const preguntaTexto = rawQuestion.toString().replace(/<[^>]*>?/gm, '').trim();
                    const blanksMeta = [];

                    if (q.al && q.al.length > 0) {
                        for (const blank of q.al) {
                            let rawOptions = [];
                            if (blank.a && blank.a.length > 0) rawOptions.push(...blank.a);
                            else if (item.d && item.d.length > 0) rawOptions.push(...item.d);
                            else if (q.d && q.d.length > 0) rawOptions.push(...q.d);

                            const options = rawOptions.map(opt => ({
                                id: opt.id,
                                text: (opt.txt || opt.t || "").toString().replace(/<[^>]*>?/gm, '').trim()
                            }));

                            const key = String(batchKeyCounter++);
                            batchForAi.push({
                                key,
                                part: partCounter,
                                question: preguntaTexto,
                                options
                            });

                            blanksMeta.push({ blankId: blank.id, key, options });
                        }
                    }
                    taskQuestionsMeta.push({ qId: q.id, blanksMeta });
                }

                parsedTasks.push({
                    nodeId: String(task.NodeId),
                    matchedCode: res.matchedCode,
                    matchedType: String(res.matchedType || "25"),
                    partCounter,
                    taskQuestionsMeta
                });

                partCounter++;
            }

            if (parsedTasks.length === 0) {
                console.log(`    [!] No se generaron preguntas para enviar en este Test.`);
                return;
            }

            // 2. UNA SOLA LLAMADA A GEMINI PARA TODO EL TEST
            console.log(`    [⚡] Consultando ${batchForAi.length} respuestas al Oráculo en un solo lote...`);
            const aiAnswersMap = await this.ai.getBatchAnswers(batchForAi, contextText);

            // 3. Empaquetamos las respuestas
            const submitAnswer = [];
            for (const pt of parsedTasks) {
                const userAnswersForTask = [];

                for (const qMeta of pt.taskQuestionsMeta) {
                    const aIdArray = [];
                    for (const bMeta of qMeta.blanksMeta) {
                        const rawAiChoice = aiAnswersMap[bMeta.key];
                        const finalAnswerId = ScraperUtil.parseAnswerId(String(rawAiChoice ?? ""), bMeta.options);
                        aIdArray.push([bMeta.blankId, finalAnswerId]);
                    }
                    userAnswersForTask.push({
                        qId: qMeta.qId,
                        aId: aIdArray
                    });
                    console.log(`      [-] Parte ${pt.partCounter} (ID: ${pt.nodeId}) -> Respuestas: ${JSON.stringify(aIdArray)}`);
                }

                submitAnswer.push({
                    iId: pt.nodeId,
                    iCode: pt.matchedCode,
                    iType: pt.matchedType,
                    ua: userAnswersForTask
                });
            }

            await this.uss.sendPing(lessonSessionId);

            // 4. Enviamos un tiempo seguro para Int16 (entre 24,000 y 31,500 ms)
            const safeTimeMs = Math.floor(Math.random() * (31500 - 24000 + 1)) + 24000;
            const status = await this.uss.SaveUserTestV1(unitId, lessonNodeId, submitAnswer, safeTimeMs);
            
            if (status.isSuccess && status.data?.finalMark !== undefined) {
                console.log(`    [#] Test Guardado Oficialmente -> Nota Final (Last Test Score): ${status.data.finalMark}%`);
            } else {
                console.log(`    [!] Respuesta inesperada al guardar Test: ${status.error || JSON.stringify(status.data)}`);
            }
        } catch (e) {
            console.log(`    [!] Error en Test:`, e.message);
        }
    }
}