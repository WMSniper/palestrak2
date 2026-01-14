document.addEventListener('DOMContentLoaded', () => {
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('/service-worker.js').then(registration => {
                console.log('ServiceWorker registration successful with scope: ', registration.scope);
            }, err => {
                console.log('ServiceWorker registration failed: ', err);
            });
        });
    }

    const STORAGE_KEYS = {
        HISTORY: 'gym_tracker_history',
        APP_STATE: 'gym_tracker_app_state',
        CUSTOM_EXERCISES: 'gym_tracker_custom_exercises',
        WORKOUTS: 'gym_tracker_workouts'
    };

    const app = {
        data: null,
        bridgeIntervalId: null,
        state: {
            currentWorkout: null,
            currentWorkoutId: null,
            sessionStartedAt: null,
            lastSummary: null,
            currentExerciseIndex: 0,
            currentSet: 1,
            timerId: null,
            timerRemaining: 0,
            restBetweenExercises: 60,
            sessionLoads: {},
            pendingStartExtra: false,
            lastCompletedWorkoutId: null,
            lastCompletedAt: null,
            bridge: {
                running: false,
                exerciseId: null,
                startMs: 0,
                durations: {}
            }
        },

        async init() {
            await this.loadData();
            const savedState = this.loadAppState();

            if (savedState) {
                this.state = {
                    ...this.state,
                    ...savedState,
                    restBetweenExercises: typeof savedState.restBetweenExercises === 'number' ? savedState.restBetweenExercises : 60,
                    pendingStartExtra: !!savedState.pendingStartExtra
                };
            }

            const canResume = Array.isArray(this.state.currentWorkout)
                && this.state.currentWorkout.length > 0
                && typeof this.state.currentExerciseIndex === 'number'
                && this.state.currentExerciseIndex < this.state.currentWorkout.length;

            if (canResume) {
                this.renderExerciseView();
                return;
            }

            if (this.state.currentWorkout) {
                this.state.currentWorkout = null;
                this.state.currentWorkoutId = null;
                this.state.currentExerciseIndex = 0;
                this.state.currentSet = 1;
                this.state.timerId = null;
                this.state.timerRemaining = 0;
                this.state.sessionLoads = {};
                this.state.pendingStartExtra = false;
                this.state.bridge = {
                    running: false,
                    exerciseId: null,
                    startMs: 0,
                    durations: this.state.bridge?.durations || {}
                };
                this.saveAppState();
            }

            this.renderInitialView();
        },

        markWorkoutCompleted(workoutId) {
            if (!workoutId || workoutId === 'EXTRA') return;
            this.state.lastCompletedWorkoutId = workoutId;
            this.state.lastCompletedAt = new Date().toISOString();
            this.saveAppState();
        },

        getWorkoutExerciseIds(workout) {
            const exs = Array.isArray(workout.exercises) ? workout.exercises : [];
            return new Set(exs.map(e => (typeof e === 'string' ? e : e.id)).filter(Boolean));
        },

        getWorkoutExerciseConfigMap(workout) {
            const map = new Map();
            const exs = Array.isArray(workout.exercises) ? workout.exercises : [];
            exs.forEach(e => {
                if (typeof e === 'string') {
                    map.set(e, null);
                } else if (e && e.id) {
                    map.set(e.id, {
                        sets: typeof e.sets === 'number' ? e.sets : null,
                        reps: typeof e.reps === 'string' || typeof e.reps === 'number' ? e.reps : null,
                        rest_between_sets: typeof e.rest_between_sets === 'number' ? e.rest_between_sets : null
                    });
                }
            });
            return map;
        },

        getWorkoutExerciseOrderMap(workout) {
            const map = new Map();
            const exs = Array.isArray(workout.exercises) ? workout.exercises : [];
            exs.forEach((e, idx) => {
                const id = typeof e === 'string' ? e : e?.id;
                if (!id) return;
                if (!map.has(id)) map.set(id, idx + 1);
            });
            return map;
        },

        async loadData() {
            try {
                const response = await fetch('data/workouts.json');
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                const baseData = await response.json();
                const customExercises = this.getCustomExercises();

                const savedWorkouts = this.getSavedWorkouts();

                // Merge base and custom exercises
                this.data = {
                    ...baseData,
                    workouts: savedWorkouts || baseData.workouts, // Load saved workouts if they exist
                    exercises: { ...baseData.exercises, ...customExercises }
                };

                this.ensureExtraWorkout();

            } catch (error) {
                console.error("Could not load workout data:", error);
                const mainContent = document.getElementById('main-content');
                mainContent.innerHTML = `<p style="color: red;">Error loading data. Please try again later.</p>`;
            }
        },

        ensureExtraWorkout() {
            if (!this.data || !Array.isArray(this.data.workouts)) return;
            const exists = this.data.workouts.some(w => w && w.id === 'EXTRA');
            if (exists) return;

            this.data.workouts.push({
                id: 'EXTRA',
                name: 'Extra',
                exercises: [],
                rest_between_exercises: 60
            });

            this.saveWorkouts();
        },

        renderInitialView() {
            const mainContent = document.getElementById('main-content');
            mainContent.innerHTML = ''; // Clear previous content

            const title = document.createElement('h2');
            title.textContent = 'Scegli il tuo Allenamento';
            mainContent.appendChild(title);

            if (this.state.lastCompletedWorkoutId) {
                const w = this.data?.workouts?.find(x => x && x.id === this.state.lastCompletedWorkoutId);
                const when = this.state.lastCompletedAt ? new Date(this.state.lastCompletedAt) : null;
                const whenText = when && Number.isFinite(when.getTime()) ? when.toLocaleString() : '';
                const card = document.createElement('div');
                card.className = 'card';
                card.innerHTML = `<p>Ultimo allenamento: <strong>${w ? w.name : this.state.lastCompletedWorkoutId}</strong>${whenText ? ` — ${whenText}` : ''}</p>`;
                mainContent.appendChild(card);
            }

            this.data.workouts.forEach(workout => {
                const button = document.createElement('button');
                button.textContent = workout.name;
                button.onclick = () => this.selectWorkout(workout.id);
                mainContent.appendChild(button);
            });

            this.renderFab();
            this.setupModal();
        },

        renderExtraOverview(workout) {
            const mainContent = document.getElementById('main-content');
            mainContent.innerHTML = '';

            const title = document.createElement('h2');
            title.textContent = workout.name;
            mainContent.appendChild(title);

            const info = document.createElement('div');
            info.className = 'card';
            info.innerHTML = '<p>Extra: viene eseguito solo dopo aver finito A / B / C.</p>';
            mainContent.appendChild(info);

            const customizeButton = document.createElement('button');
            customizeButton.textContent = 'Personalizza Extra';
            customizeButton.type = 'button';
            customizeButton.onclick = () => {
                const allExercises = Object.values(this.data.exercises);
                const workoutExerciseIds = this.getWorkoutExerciseIds(workout);
                this.renderExerciseSelection(workout, allExercises, workoutExerciseIds);
            };
            mainContent.appendChild(customizeButton);

            const backButton = document.createElement('button');
            backButton.textContent = 'Indietro';
            backButton.className = 'secondary';
            backButton.type = 'button';
            backButton.onclick = () => this.renderInitialView();
            mainContent.appendChild(backButton);

            this.renderFab();
            this.setupModal();
        },

        buildSelectedExercisesFromWorkout(workout) {
            const entries = Array.isArray(workout.exercises) ? workout.exercises : [];
            return entries
                .map(e => {
                    const id = typeof e === 'string' ? e : e?.id;
                    if (!id) return null;
                    const base = this.data.exercises[id] || { id, name: id };
                    const sets = typeof e === 'object' && typeof e?.sets === 'number' ? e.sets : (typeof base.default_sets === 'number' ? base.default_sets : 3);
                    const reps = typeof e === 'object' && (typeof e?.reps === 'string' || typeof e?.reps === 'number') ? e.reps : (base.default_reps ?? '10');
                    const rest = typeof e === 'object' && typeof e?.rest_between_sets === 'number' ? e.rest_between_sets : (typeof base.default_timer === 'number' ? base.default_timer : 60);
                    return {
                        ...base,
                        id,
                        default_sets: sets,
                        default_reps: reps.toString(),
                        default_timer: rest
                    };
                })
                .filter(Boolean);
        },

        selectWorkout(workoutId) {
            const workout = this.data.workouts.find(w => w.id === workoutId);
            if (!workout) return;

            if (workout.id === 'EXTRA') {
                if (this.state.pendingStartExtra) {
                    const hasSavedExercises = Array.isArray(workout.exercises) && workout.exercises.length > 0;
                    if (hasSavedExercises) {
                        const restBetweenExercises = typeof workout.rest_between_exercises === 'number' ? workout.rest_between_exercises : 60;
                        const selectedExercises = this.buildSelectedExercisesFromWorkout(workout);
                        this.state.pendingStartExtra = false;
                        this.saveAppState();
                        this.startWorkoutFromWorkoutId(workout.id, selectedExercises, restBetweenExercises);
                        return;
                    }
                }

                const hasSavedExercises = Array.isArray(workout.exercises) && workout.exercises.length > 0;
                if (hasSavedExercises) {
                    this.renderExtraOverview(workout);
                    return;
                }

                const allExercises = Object.values(this.data.exercises);
                const workoutExerciseIds = this.getWorkoutExerciseIds(workout);
                this.renderExerciseSelection(workout, allExercises, workoutExerciseIds);
                return;
            }

            const hasSavedExercises = Array.isArray(workout.exercises) && workout.exercises.length > 0;
            if (hasSavedExercises) {
                this.renderWorkoutOverview(workout);
                return;
            }

            // Now, we get ALL exercises and let the user pick.
            const allExercises = Object.values(this.data.exercises);
            const workoutExerciseIds = this.getWorkoutExerciseIds(workout);

            this.renderExerciseSelection(workout, allExercises, workoutExerciseIds);
        },

        renderWorkoutOverview(workout) {
            const mainContent = document.getElementById('main-content');
            mainContent.innerHTML = '';

            const title = document.createElement('h2');
            title.textContent = workout.name;
            mainContent.appendChild(title);

            const restBetweenExercises = typeof workout.rest_between_exercises === 'number' ? workout.rest_between_exercises : 60;
            const info = document.createElement('div');
            info.className = 'card';
            const ids = Array.isArray(workout.exercises) ? workout.exercises.map(e => (typeof e === 'string' ? e : e?.id)).filter(Boolean) : [];
            const names = ids.map(id => this.data.exercises?.[id]?.name || id);
            const listHtml = names.length
                ? names.map((n, i) => `<p>${i + 1}. ${n}</p>`).join('')
                : '<p>Nessun esercizio selezionato.</p>';
            info.innerHTML = `<p>Recupero tra esercizi: ${restBetweenExercises}s</p>${listHtml}`;
            mainContent.appendChild(info);

            const startButton = document.createElement('button');
            startButton.textContent = 'Avvia Allenamento';
            startButton.type = 'button';
            startButton.onclick = () => {
                const selectedExercises = this.buildSelectedExercisesFromWorkout(workout);

                this.startWorkoutFromWorkoutId(workout.id, selectedExercises, restBetweenExercises);
            };
            mainContent.appendChild(startButton);

            const customizeButton = document.createElement('button');
            customizeButton.textContent = 'Personalizza';
            customizeButton.className = 'secondary';
            customizeButton.type = 'button';
            customizeButton.onclick = () => {
                const allExercises = Object.values(this.data.exercises);
                const workoutExerciseIds = this.getWorkoutExerciseIds(workout);
                this.renderExerciseSelection(workout, allExercises, workoutExerciseIds);
            };
            mainContent.appendChild(customizeButton);

            const backButton = document.createElement('button');
            backButton.textContent = 'Indietro';
            backButton.className = 'secondary';
            backButton.type = 'button';
            backButton.onclick = () => this.renderInitialView();
            mainContent.appendChild(backButton);

            this.renderFab();
            this.setupModal();
        },

        renderExerciseSelection(workout, allExercises, workoutExerciseIds) {
            const mainContent = document.getElementById('main-content');
            mainContent.innerHTML = '';

            const title = document.createElement('h2');
            title.textContent = `Personalizza: ${workout.name}`;
            mainContent.appendChild(title);

            const form = document.createElement('form');
            form.id = 'exercise-selection-form';

            const restBetweenExercisesWrapper = document.createElement('div');
            restBetweenExercisesWrapper.className = 'exercise-input';

            const restBetweenExercisesLabel = document.createElement('label');
            restBetweenExercisesLabel.setAttribute('for', 'workout-rest-between-exercises');
            restBetweenExercisesLabel.textContent = 'Recupero tra esercizi (sec)';

            const restBetweenExercisesInput = document.createElement('input');
            restBetweenExercisesInput.type = 'number';
            restBetweenExercisesInput.id = 'workout-rest-between-exercises';
            restBetweenExercisesInput.min = '0';
            restBetweenExercisesInput.value = typeof workout.rest_between_exercises === 'number' ? workout.rest_between_exercises : 60;

            restBetweenExercisesWrapper.appendChild(restBetweenExercisesLabel);
            restBetweenExercisesWrapper.appendChild(restBetweenExercisesInput);
            form.appendChild(restBetweenExercisesWrapper);

            const list = document.createElement('ul');
            list.className = 'exercise-list-custom';

            const existingConfigMap = this.getWorkoutExerciseConfigMap(workout);
            const existingOrderMap = this.getWorkoutExerciseOrderMap(workout);

            const getNextOrder = () => {
                const currentOrders = Array.from(form.querySelectorAll('input[data-field="order"]'))
                    .filter(i => i.offsetParent !== null)
                    .map(i => parseInt(i.value, 10))
                    .filter(n => Number.isFinite(n));
                return currentOrders.length ? Math.max(...currentOrders) + 1 : 1;
            };

            allExercises.forEach(ex => {
                const listItem = document.createElement('li');
                const label = document.createElement('label');

                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.name = 'exercise';
                checkbox.value = ex.id;
                checkbox.checked = workoutExerciseIds.has(ex.id);

                const existingCfg = existingConfigMap.get(ex.id);
                const defaultSets = typeof existingCfg?.sets === 'number' ? existingCfg.sets : (typeof ex.default_sets === 'number' ? ex.default_sets : 3);
                const defaultReps = (existingCfg?.reps ?? ex.default_reps ?? 10).toString();
                const defaultRestBetweenSets = typeof existingCfg?.rest_between_sets === 'number' ? existingCfg.rest_between_sets : (typeof ex.default_timer === 'number' ? ex.default_timer : 60);
                const existingOrder = existingOrderMap.get(ex.id);
                const defaultOrder = typeof existingOrder === 'number' ? existingOrder : 1;

                const details = document.createElement('div');
                details.className = 'exercise-selection-details';

                const setsInput = document.createElement('input');
                setsInput.type = 'number';
                setsInput.min = '1';
                setsInput.value = defaultSets;
                setsInput.dataset.exerciseId = ex.id;
                setsInput.dataset.field = 'sets';

                const repsInput = document.createElement('input');
                repsInput.type = 'text';
                repsInput.value = defaultReps;
                repsInput.dataset.exerciseId = ex.id;
                repsInput.dataset.field = 'reps';

                const restInput = document.createElement('input');
                restInput.type = 'number';
                restInput.min = '0';
                restInput.value = defaultRestBetweenSets;
                restInput.dataset.exerciseId = ex.id;
                restInput.dataset.field = 'rest_between_sets';

                const orderInput = document.createElement('input');
                orderInput.type = 'number';
                orderInput.min = '1';
                orderInput.value = checkbox.checked ? defaultOrder : 1;
                orderInput.dataset.exerciseId = ex.id;
                orderInput.dataset.field = 'order';

                details.appendChild(setsInput);
                details.appendChild(repsInput);
                details.appendChild(restInput);
                details.appendChild(orderInput);

                details.style.display = checkbox.checked ? 'grid' : 'none';

                checkbox.onchange = () => {
                    details.style.display = checkbox.checked ? 'grid' : 'none';
                    if (checkbox.checked) {
                        orderInput.value = typeof existingOrder === 'number' ? existingOrder : getNextOrder();
                    }
                };

                label.appendChild(checkbox);
                label.append(` ${ex.name}`);
                listItem.appendChild(label);
                listItem.appendChild(details);
                list.appendChild(listItem);
            });

            form.appendChild(list);
            mainContent.appendChild(form);

            const isExtra = workout.id === 'EXTRA';
            const saveButton = document.createElement('button');
            saveButton.textContent = isExtra ? 'Salva Extra' : 'Avvia Allenamento';
            saveButton.type = 'button';
            saveButton.onclick = () => {
                const selectedIds = Array.from(form.querySelectorAll('input[name="exercise"]:checked')).map(cb => cb.value);

                const selectedEntries = selectedIds.map(id => {
                    const setsEl = form.querySelector(`input[data-exercise-id="${id}"][data-field="sets"]`);
                    const repsEl = form.querySelector(`input[data-exercise-id="${id}"][data-field="reps"]`);
                    const restEl = form.querySelector(`input[data-exercise-id="${id}"][data-field="rest_between_sets"]`);
                    const orderEl = form.querySelector(`input[data-exercise-id="${id}"][data-field="order"]`);

                    const sets = Math.max(1, parseInt(setsEl?.value, 10) || 1);
                    const reps = (repsEl?.value ?? '').toString().trim() || '10';
                    const rest_between_sets = Math.max(0, parseInt(restEl?.value, 10) || 0);
                    const order = Math.max(1, parseInt(orderEl?.value, 10) || 1);

                    return { id, sets, reps, rest_between_sets, order };
                });

                const sortedEntries = selectedEntries
                    .slice()
                    .sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id))
                    .map(e => ({ id: e.id, sets: e.sets, reps: e.reps, rest_between_sets: e.rest_between_sets }));

                const restBetweenExercises = Math.max(0, parseInt(restBetweenExercisesInput.value, 10) || 0);

                const workoutToUpdate = this.data.workouts.find(w => w.id === workout.id);
                if (workoutToUpdate) {
                    workoutToUpdate.exercises = sortedEntries;
                    workoutToUpdate.rest_between_exercises = restBetweenExercises;
                    this.saveWorkouts();
                }

                const selectedExercises = sortedEntries.map(entry => {
                    const base = this.data.exercises[entry.id] || { id: entry.id, name: entry.id };
                    return {
                        ...base,
                        id: entry.id,
                        default_sets: entry.sets,
                        default_reps: entry.reps,
                        default_timer: entry.rest_between_sets
                    };
                });

                if (isExtra) {
                    if (this.state.pendingStartExtra) {
                        this.state.pendingStartExtra = false;
                        this.saveAppState();
                        this.startWorkoutFromWorkoutId(workout.id, selectedExercises, restBetweenExercises);
                        return;
                    }
                    this.renderExtraOverview(workoutToUpdate || workout);
                    return;
                }

                this.startWorkoutFromWorkoutId(workout.id, selectedExercises, restBetweenExercises);
            };
            mainContent.appendChild(saveButton);

            const backButton = document.createElement('button');
            backButton.textContent = 'Indietro';
            backButton.className = 'secondary';
            backButton.type = 'button';
            backButton.onclick = () => {
                if (workout.id === 'EXTRA' && this.state.pendingStartExtra) {
                    this.state.pendingStartExtra = false;
                    this.saveAppState();
                }
                this.renderInitialView();
            };
            mainContent.appendChild(backButton);
        },

        startWorkout(exercises, restBetweenExercises) {
            this.state = {
                ...this.state,
                currentWorkout: exercises,
                currentWorkoutId: null,
                sessionStartedAt: new Date().toISOString(),
                lastSummary: null,
                currentExerciseIndex: 0,
                currentSet: 1,
                restBetweenExercises: typeof restBetweenExercises === 'number' ? restBetweenExercises : 60,
                sessionLoads: {},
                bridge: {
                    running: false,
                    exerciseId: null,
                    startMs: 0,
                    durations: {}
                }
            };
            this.saveAppState();
            this.renderExerciseView();
        },

        startWorkoutFromWorkoutId(workoutId, exercises, restBetweenExercises) {
            this.startWorkout(exercises, restBetweenExercises);
            this.state.currentWorkoutId = workoutId;
            this.state.sessionStartedAt = new Date().toISOString();
            this.saveAppState();
        },

        getTargetRepsForSet(repsPattern, setNumber) {
            const raw = (repsPattern ?? '').toString().trim();
            if (!raw) return '';
            const parts = raw.split('-').map(p => p.trim()).filter(Boolean);
            if (parts.length === 0) return '';
            const index = Math.max(0, setNumber - 1);
            const value = parts[Math.min(index, parts.length - 1)];
            const asNumber = parseInt(value, 10);
            return Number.isFinite(asNumber) ? asNumber : value;
        },

        renderExerciseView() {
            const mainContent = document.getElementById('main-content');
            mainContent.innerHTML = '';

            if (!this.state.currentWorkout || this.state.currentExerciseIndex >= this.state.currentWorkout.length) {
                this.renderInitialView();
                return;
            }

            const exercise = this.state.currentWorkout[this.state.currentExerciseIndex];
            if (!this.state.currentSet) {
                this.state.currentSet = 1;
            }

            const history = this.getHistory();
            const exerciseHistory = history[exercise.id];
            let lastPerformanceHtml = "<p>No previous data.</p>";
            if (exerciseHistory && exerciseHistory.length > 0) {
                const recent = exerciseHistory.slice(-5).reverse();
                lastPerformanceHtml = recent.map(s => {
                    const d = new Date(s.date);
                    const dateStr = Number.isFinite(d.getTime()) ? d.toLocaleDateString() : '';
                    const timeStr = Number.isFinite(d.getTime()) ? d.toLocaleTimeString().slice(0, 5) : '';
                    const note = s.notes ? ` — <em>${s.notes}</em>` : '';
                    const dur = typeof s.duration_sec === 'number' ? ` — ${this.formatDuration(s.duration_sec)}` : '';
                    return `<p>${dateStr} ${timeStr} — ${s.load}kg, ${s.reps} reps${dur}${note}</p>`;
                }).join('');
            }

            // Main container for the exercise view
            const container = document.createElement('div');
            container.className = 'exercise-view';

            // Header: Exercise Name and Progress
            let imageHtml = '';
            if (exercise.image) {
                imageHtml = `<img src="${exercise.image}" alt="${exercise.name}" class="exercise-image">`;
            }

            const targetReps = this.getTargetRepsForSet(exercise.default_reps, this.state.currentSet);

            const isBridge = (exercise.name ?? '').toString().trim().toLowerCase() === 'ponte';
            const bridgeDurations = (this.state.bridge?.durations && this.state.bridge.durations[exercise.id]) ? this.state.bridge.durations[exercise.id] : [];
            const bridgeMax = bridgeDurations.length ? Math.max(...bridgeDurations) : null;
            const bridgeAvg = bridgeDurations.length ? Math.round(bridgeDurations.reduce((a, b) => a + b, 0) / bridgeDurations.length) : null;
            const bridgeStatsHtml = isBridge
                ? `<div class="bridge-panel">
                        <button type="button" id="bridge-start">Avvia Cronometro</button>
                        <div id="bridge-time">00:00</div>
                        <div id="bridge-stats">Max: ${bridgeMax != null ? this.formatDuration(bridgeMax) : '--:--'} — Media: ${bridgeAvg != null ? this.formatDuration(bridgeAvg) : '--:--'}</div>
                   </div>`
                : '';

            container.innerHTML = `
                ${imageHtml}
                <div class="exercise-header">
                    <h3>${exercise.name}</h3>
                    <span>Esercizio ${this.state.currentExerciseIndex + 1} / ${this.state.currentWorkout.length}</span>
                </div>
                <div class="exercise-details">
                    <p>Set ${this.state.currentSet} / ${exercise.default_sets}</p>
                    <p>Reps: ${targetReps}</p>
                </div>
                ${bridgeStatsHtml}
                <div class="exercise-input">
                    <label for="load">Load (kg):</label>
                    <input type="number" id="load" placeholder="0">
                    <label for="notes">Notes:</label>
                    <textarea id="notes" rows="2"></textarea>
                </div>
                <div class="history">
                    <h4>Last time:</h4>
                    ${lastPerformanceHtml}
                </div>
            `;

            const loadInput = container.querySelector('#load');
            const existingSessionLoad = this.state.sessionLoads && Object.prototype.hasOwnProperty.call(this.state.sessionLoads, exercise.id)
                ? this.state.sessionLoads[exercise.id]
                : null;

            if (loadInput) {
                if (existingSessionLoad != null && existingSessionLoad !== '') {
                    loadInput.value = existingSessionLoad;
                } else if (exerciseHistory && exerciseHistory.length > 0) {
                    const last = exerciseHistory[exerciseHistory.length - 1];
                    if (typeof last.load === 'number') {
                        loadInput.value = last.load;
                        this.state.sessionLoads = { ...(this.state.sessionLoads || {}), [exercise.id]: last.load };
                        this.saveAppState();
                    }
                }

                loadInput.oninput = () => {
                    const raw = (loadInput.value ?? '').toString().trim();
                    if (!raw) {
                        const next = { ...(this.state.sessionLoads || {}) };
                        delete next[exercise.id];
                        this.state.sessionLoads = next;
                        this.saveAppState();
                        return;
                    }

                    const val = parseFloat(raw);
                    if (!Number.isFinite(val)) return;
                    this.state.sessionLoads = { ...(this.state.sessionLoads || {}), [exercise.id]: val };
                    this.saveAppState();
                };
            }

            if (isBridge) {
                this.setupBridgeUi(container, exercise.id);
            }

            // Action Buttons
            const actions = document.createElement('div');
            actions.className = 'exercise-actions';

            if (this.state.currentSet < exercise.default_sets) {
                const nextSetButton = document.createElement('button');
                nextSetButton.textContent = '✓ Complete Set';
                nextSetButton.onclick = () => this.nextSet();
                actions.appendChild(nextSetButton);
            } else {
                const completeExerciseButton = document.createElement('button');
                completeExerciseButton.textContent = '✓ Complete Exercise';
                completeExerciseButton.onclick = () => this.nextExercise();
                actions.appendChild(completeExerciseButton);

                const addSetButton = document.createElement('button');
                addSetButton.textContent = '↺ Add Set';
                addSetButton.className = 'secondary';
                addSetButton.onclick = () => this.addSet();
                actions.appendChild(addSetButton);
            }

            container.appendChild(actions);
            mainContent.appendChild(container);

        },

        nextSet() {
            const exercise = this.state.currentWorkout[this.state.currentExerciseIndex];
            const durationSec = this.finalizeBridgeSetIfNeeded(exercise);
            this.saveCurrentSetPerformance({ durationSec });
            this.state.currentSet++;
            this.saveAppState();
            this.renderTimerView(exercise.default_timer, () => this.renderExerciseView());
        },

        addSet() {
            const exercise = this.state.currentWorkout[this.state.currentExerciseIndex];
            exercise.default_sets++;
            this.renderExerciseView();
        },

        nextExercise() {
            const exercise = this.state.currentWorkout[this.state.currentExerciseIndex];
            const durationSec = this.finalizeBridgeSetIfNeeded(exercise);
            this.saveCurrentSetPerformance({ durationSec }); // Save the last set
            this.state.currentExerciseIndex++;
            this.state.currentSet = 1;

            if (!this.state.currentWorkout || this.state.currentExerciseIndex >= this.state.currentWorkout.length) {
                const summary = this.buildWorkoutSummary();
                this.completeWorkout(summary);
                this.renderWorkoutSummary(summary);
                return;
            }

            this.saveAppState();

            const timerDuration = Math.max(0, this.state.restBetweenExercises || 0);
            this.renderTimerView(timerDuration, () => this.renderExerciseView());
        },

        renderTimerView(duration, onTimerEndCallback) {
            this.stopBridgeInterval();
            const mainContent = document.getElementById('main-content');
            mainContent.innerHTML = `
                <div class="timer-view">
                    <h2>Rest</h2>
                    <div class="timer-display"></div>
                    <button class="skip-timer">Skip</button>
                </div>
            `;

            mainContent.querySelector('.skip-timer').onclick = () => {
                if (this.state.timerId) clearInterval(this.state.timerId);
                this.state.timerId = null;
                onTimerEndCallback();
            };

            this.startTimer(duration, onTimerEndCallback);
        },

        startTimer(duration, onTimerEndCallback) {
            if (this.state.timerId) clearInterval(this.state.timerId);

            if (!duration || duration <= 0) {
                this.state.timerRemaining = 0;
                this.updateTimerDisplay();
                onTimerEndCallback();
                return;
            }

            this.state.timerRemaining = duration;
            const timerDisplay = document.querySelector('.timer-display');

            this.updateTimerDisplay();

            this.state.timerId = setInterval(() => {
                this.state.timerRemaining--;
                this.updateTimerDisplay();
                if (this.state.timerRemaining <= 0) {
                    clearInterval(this.state.timerId);
                    this.state.timerId = null;
                    onTimerEndCallback();
                }
            }, 1000);
        },

        resetTimer(duration) {
            if (this.state.timerId) clearInterval(this.state.timerId);
            this.state.timerId = null;
            this.state.timerRemaining = duration;
            this.updateTimerDisplay();
        },

        updateTimerDisplay() {
            const timerDisplay = document.querySelector('.timer-display');
            if (!timerDisplay) return;
            const minutes = Math.floor(this.state.timerRemaining / 60).toString().padStart(2, '0');
            const seconds = (this.state.timerRemaining % 60).toString().padStart(2, '0');
            timerDisplay.textContent = `${minutes}:${seconds}`;
        },

        // --- Storage Helpers ---
        saveCurrentSetPerformance({ durationSec } = {}) {
            const exercise = this.state.currentWorkout[this.state.currentExerciseIndex];
            const load = document.getElementById('load').value;
            const notes = document.getElementById('notes').value;

            const targetReps = this.getTargetRepsForSet(exercise.default_reps, this.state.currentSet);

            const history = this.getHistory();
            if (!history[exercise.id]) {
                history[exercise.id] = [];
            }

            const entry = {
                date: new Date().toISOString(),
                sets: this.state.currentSet,
                reps: targetReps,
                load: parseFloat(load) || 0,
                notes: notes,
                exercise_name: exercise.name,
                workout_id: this.state.currentWorkoutId
            };

            if (typeof durationSec === 'number' && Number.isFinite(durationSec)) {
                entry.duration_sec = durationSec;
            }

            const last = history[exercise.id].length ? history[exercise.id][history[exercise.id].length - 1] : null;
            const sameAsLast = last
                && last.load === entry.load
                && `${last.reps}` === `${entry.reps}`
                && `${last.notes || ''}` === `${entry.notes || ''}`
                && `${last.workout_id || ''}` === `${entry.workout_id || ''}`
                && `${last.exercise_name || ''}` === `${entry.exercise_name || ''}`
                && (typeof last.duration_sec === 'number' ? last.duration_sec : null) === (typeof entry.duration_sec === 'number' ? entry.duration_sec : null);

            if (!sameAsLast) {
                history[exercise.id].push(entry);
            }

            this.saveHistory(history);
            console.log('Set performance saved for', exercise.name);
        },

        buildWorkoutSummary() {
            const workoutId = this.state.currentWorkoutId;
            const workout = workoutId ? this.data?.workouts?.find(w => w && w.id === workoutId) : null;
            const workoutName = workout?.name || workoutId || 'Allenamento';
            const startedAt = this.state.sessionStartedAt;
            const endedAt = new Date().toISOString();
            const exercises = Array.isArray(this.state.currentWorkout) ? this.state.currentWorkout.map(e => ({
                id: e.id,
                name: e.name,
                image: e.image || null
            })) : [];
            return { workoutId, workoutName, startedAt, endedAt, exercises };
        },

        completeWorkout(summary) {
            if (summary?.workoutId && summary.workoutId !== 'EXTRA') {
                this.markWorkoutCompleted(summary.workoutId);
            }

            this.state.lastSummary = summary || null;
            this.state.currentWorkout = null;
            this.state.currentWorkoutId = null;
            this.state.sessionStartedAt = null;
            this.state.currentExerciseIndex = 0;
            this.state.currentSet = 1;
            this.state.timerId = null;
            this.state.timerRemaining = 0;
            this.state.sessionLoads = {};
            this.state.pendingStartExtra = false;
            this.state.bridge = {
                running: false,
                exerciseId: null,
                startMs: 0,
                durations: this.state.bridge?.durations || {}
            };
            this.saveAppState();
        },

        renderWorkoutSummary(summary) {
            const mainContent = document.getElementById('main-content');
            mainContent.innerHTML = '';

            const title = document.createElement('h2');
            title.textContent = 'Riepilogo';
            mainContent.appendChild(title);

            const card = document.createElement('div');
            card.className = 'card';
            const when = summary?.endedAt ? new Date(summary.endedAt) : null;
            const whenText = when && Number.isFinite(when.getTime()) ? when.toLocaleString() : '';
            card.innerHTML = `<p><strong>${summary?.workoutName || ''}</strong>${whenText ? ` — ${whenText}` : ''}</p>`;
            mainContent.appendChild(card);

            const history = this.getHistory();
            const startMs = summary?.startedAt ? new Date(summary.startedAt).getTime() : null;
            const endMs = summary?.endedAt ? new Date(summary.endedAt).getTime() : null;

            (summary?.exercises || []).forEach(ex => {
                const exCard = document.createElement('div');
                exCard.className = 'card';

                const img = ex.image ? `<img src="${ex.image}" alt="${ex.name}" class="exercise-image">` : '';
                const entries = Array.isArray(history[ex.id]) ? history[ex.id] : [];
                const todays = (startMs && endMs)
                    ? entries.filter(r => {
                        const t = new Date(r.date).getTime();
                        return Number.isFinite(t) && t >= startMs && t <= endMs;
                    })
                    : [];

                const lines = todays.length
                    ? todays.map(r => {
                        const dur = typeof r.duration_sec === 'number' ? ` — ${this.formatDuration(r.duration_sec)}` : '';
                        return `<p>${r.load}kg, ${r.reps} reps${dur}${r.notes ? ` — <em>${r.notes}</em>` : ''}</p>`;
                    }).join('')
                    : '<p>Nessun record salvato.</p>';

                exCard.innerHTML = `${img}<p><strong>${ex.name}</strong></p>${lines}`;
                mainContent.appendChild(exCard);
            });

            if (summary?.workoutId && summary.workoutId !== 'EXTRA') {
                const extra = this.data?.workouts?.find(w => w && w.id === 'EXTRA');
                const hasSavedExercises = !!(extra && Array.isArray(extra.exercises) && extra.exercises.length > 0);
                if (hasSavedExercises) {
                    const extraButton = document.createElement('button');
                    extraButton.textContent = 'Continua con Extra';
                    extraButton.type = 'button';
                    extraButton.onclick = () => {
                        const restBetweenExercises = typeof extra.rest_between_exercises === 'number' ? extra.rest_between_exercises : 60;
                        const selectedExercises = this.buildSelectedExercisesFromWorkout(extra);
                        this.startWorkoutFromWorkoutId(extra.id, selectedExercises, restBetweenExercises);
                    };
                    mainContent.appendChild(extraButton);
                }
            }

            const homeButton = document.createElement('button');
            homeButton.textContent = 'Torna alla Home';
            homeButton.className = 'secondary';
            homeButton.type = 'button';
            homeButton.onclick = () => {
                this.state.lastSummary = null;
                this.saveAppState();
                this.renderInitialView();
            };
            mainContent.appendChild(homeButton);

            this.renderFab();
            this.setupModal();
        },

        createWorkoutFlow() {
            const name = prompt('Nome scheda allenamento:');
            if (!name) return;
            const trimmed = name.toString().trim();
            if (!trimmed) return;

            const id = `W_${Date.now()}`;
            this.data.workouts.push({
                id,
                name: trimmed,
                exercises: [],
                rest_between_exercises: 60
            });
            this.saveWorkouts();
            this.renderInitialView();
        },

        renderManageWorkouts() {
            const mainContent = document.getElementById('main-content');
            mainContent.innerHTML = '';

            const title = document.createElement('h2');
            title.textContent = 'Gestisci Schede';
            mainContent.appendChild(title);

            const list = document.createElement('div');

            (this.data.workouts || []).forEach(w => {
                const row = document.createElement('div');
                row.className = 'card';
                const locked = ['A', 'B', 'C', 'EXTRA'].includes(w.id);
                row.innerHTML = `<p><strong>${w.name}</strong> <span style="color: var(--text-secondary-color)">(${w.id})</span></p>`;

                if (!locked) {
                    const del = document.createElement('button');
                    del.textContent = 'Elimina Scheda';
                    del.className = 'secondary';
                    del.type = 'button';
                    del.onclick = () => {
                        const ok = confirm(`Eliminare la scheda "${w.name}"?`);
                        if (!ok) return;
                        this.data.workouts = this.data.workouts.filter(x => x.id !== w.id);
                        if (this.state.lastCompletedWorkoutId === w.id) {
                            this.state.lastCompletedWorkoutId = null;
                            this.state.lastCompletedAt = null;
                            this.saveAppState();
                        }
                        this.saveWorkouts();
                        this.renderManageWorkouts();
                    };
                    row.appendChild(del);
                }

                list.appendChild(row);
            });

            mainContent.appendChild(list);

            const backButton = document.createElement('button');
            backButton.textContent = 'Indietro';
            backButton.className = 'secondary';
            backButton.type = 'button';
            backButton.onclick = () => this.renderInitialView();
            mainContent.appendChild(backButton);

            this.renderFab();
            this.setupModal();
        },

        renderManageExercises() {
            const mainContent = document.getElementById('main-content');
            mainContent.innerHTML = '';

            const title = document.createElement('h2');
            title.textContent = 'Gestisci Esercizi';
            mainContent.appendChild(title);

            const custom = this.getCustomExercises();
            const ids = Object.keys(custom);

            if (!ids.length) {
                const card = document.createElement('div');
                card.className = 'card';
                card.innerHTML = '<p>Nessun esercizio personalizzato.</p>';
                mainContent.appendChild(card);
            } else {
                ids.forEach(id => {
                    const ex = custom[id];
                    const row = document.createElement('div');
                    row.className = 'card';
                    row.innerHTML = `<p><strong>${ex?.name || id}</strong></p>`;

                    const del = document.createElement('button');
                    del.textContent = 'Elimina Esercizio';
                    del.className = 'secondary';
                    del.type = 'button';
                    del.onclick = () => {
                        const ok = confirm(`Eliminare l'esercizio "${ex?.name || id}"?`);
                        if (!ok) return;

                        const next = this.getCustomExercises();
                        delete next[id];
                        this.saveCustomExercises(next);

                        (this.data.workouts || []).forEach(w => {
                            if (!Array.isArray(w.exercises)) return;
                            w.exercises = w.exercises.filter(e => (typeof e === 'string' ? e : e?.id) !== id);
                        });
                        this.saveWorkouts();

                        delete this.data.exercises[id];
                        this.renderManageExercises();
                    };

                    const recordsBtn = document.createElement('button');
                    recordsBtn.textContent = 'Vedi Record';
                    recordsBtn.type = 'button';
                    recordsBtn.onclick = () => this.renderExerciseRecordsBrowser(id);

                    row.appendChild(recordsBtn);
                    row.appendChild(del);
                    mainContent.appendChild(row);
                });
            }

            const backButton = document.createElement('button');
            backButton.textContent = 'Indietro';
            backButton.className = 'secondary';
            backButton.type = 'button';
            backButton.onclick = () => this.renderInitialView();
            mainContent.appendChild(backButton);

            this.renderFab();
            this.setupModal();
        },

        renderExerciseRecordsBrowser(preselectExerciseId) {
            const mainContent = document.getElementById('main-content');
            mainContent.innerHTML = '';

            const title = document.createElement('h2');
            title.textContent = 'Record Esercizi';
            mainContent.appendChild(title);

            const allExercises = Object.values(this.data.exercises || {});
            allExercises.sort((a, b) => (a?.name || '').localeCompare(b?.name || ''));

            const wrapper = document.createElement('div');
            wrapper.className = 'exercise-input';

            const label = document.createElement('label');
            label.textContent = 'Scegli esercizio';
            wrapper.appendChild(label);

            const select = document.createElement('select');
            select.style.width = '100%';
            select.style.padding = '0.85rem';
            select.style.borderRadius = '12px';
            select.style.backgroundColor = 'var(--secondary-color)';
            select.style.color = 'var(--text-color)';
            select.style.border = 'none';
            select.style.marginBottom = '0.75rem';

            allExercises.forEach(ex => {
                const opt = document.createElement('option');
                opt.value = ex.id;
                opt.textContent = ex.name;
                select.appendChild(opt);
            });

            if (preselectExerciseId) {
                select.value = preselectExerciseId;
            }

            wrapper.appendChild(select);
            mainContent.appendChild(wrapper);

            const recordsContainer = document.createElement('div');
            mainContent.appendChild(recordsContainer);

            const renderFor = (exerciseId) => {
                recordsContainer.innerHTML = '';
                const history = this.getHistory();
                const rows = Array.isArray(history[exerciseId]) ? history[exerciseId] : [];

                const header = document.createElement('div');
                header.className = 'card';
                header.innerHTML = `<p>Record totali: <strong>${rows.length}</strong></p>`;
                recordsContainer.appendChild(header);

                const clearBtn = document.createElement('button');
                clearBtn.textContent = 'Cancella tutti i record';
                clearBtn.className = 'secondary';
                clearBtn.type = 'button';
                clearBtn.onclick = () => {
                    const ok = confirm('Cancellare tutti i record di questo esercizio?');
                    if (!ok) return;
                    const h = this.getHistory();
                    delete h[exerciseId];
                    this.saveHistory(h);
                    renderFor(exerciseId);
                };
                recordsContainer.appendChild(clearBtn);

                if (!rows.length) {
                    const empty = document.createElement('div');
                    empty.className = 'card';
                    empty.innerHTML = '<p>Nessun record.</p>';
                    recordsContainer.appendChild(empty);
                    return;
                }

                const list = document.createElement('div');
                rows.slice().reverse().forEach((r, idxFromEnd) => {
                    const idx = rows.length - 1 - idxFromEnd;
                    const card = document.createElement('div');
                    card.className = 'card';
                    const d = new Date(r.date);
                    const dateStr = Number.isFinite(d.getTime()) ? d.toLocaleString() : r.date;
                    const dur = typeof r.duration_sec === 'number' ? ` — ${this.formatDuration(r.duration_sec)}` : '';
                    const note = r.notes ? ` — <em>${r.notes}</em>` : '';
                    card.innerHTML = `<p><strong>${dateStr}</strong></p><p>${r.load}kg, ${r.reps} reps${dur}${note}</p>`;

                    const del = document.createElement('button');
                    del.textContent = 'Elimina record';
                    del.className = 'secondary';
                    del.type = 'button';
                    del.onclick = () => {
                        const ok = confirm('Eliminare questo record?');
                        if (!ok) return;
                        const h = this.getHistory();
                        const arr = Array.isArray(h[exerciseId]) ? h[exerciseId] : [];
                        arr.splice(idx, 1);
                        if (arr.length) h[exerciseId] = arr; else delete h[exerciseId];
                        this.saveHistory(h);
                        renderFor(exerciseId);
                    };
                    card.appendChild(del);
                    list.appendChild(card);
                });
                recordsContainer.appendChild(list);
            };

            select.onchange = () => renderFor(select.value);
            if (select.value) renderFor(select.value);

            const backButton = document.createElement('button');
            backButton.textContent = 'Indietro';
            backButton.className = 'secondary';
            backButton.type = 'button';
            backButton.onclick = () => this.renderInitialView();
            mainContent.appendChild(backButton);

            this.renderFab();
            this.setupModal();
        },

        setupBridgeUi(container, exerciseId) {
            const btn = container.querySelector('#bridge-start');
            const timeEl = container.querySelector('#bridge-time');
            if (!btn || !timeEl) return;

            const isRunning = this.state.bridge?.running && this.state.bridge.exerciseId === exerciseId;
            btn.disabled = isRunning;

            btn.onclick = () => {
                if (!this.state.bridge) {
                    this.state.bridge = { running: false, exerciseId: null, startMs: 0, durations: {} };
                }

                if (!this.state.bridge.durations) {
                    this.state.bridge.durations = {};
                }

                if (!this.state.bridge.durations[exerciseId]) {
                    this.state.bridge.durations[exerciseId] = [];
                }

                this.state.bridge.running = true;
                this.state.bridge.exerciseId = exerciseId;
                this.state.bridge.startMs = Date.now();
                this.saveAppState();
                btn.disabled = true;
                this.startBridgeInterval(timeEl);
            };

            if (isRunning) {
                this.startBridgeInterval(timeEl);
            } else {
                timeEl.textContent = '00:00';
            }
        },

        startBridgeInterval(timeEl) {
            this.stopBridgeInterval();
            this.bridgeIntervalId = setInterval(() => {
                if (!this.state.bridge?.running || !this.state.bridge.startMs) return;
                const sec = Math.max(0, Math.floor((Date.now() - this.state.bridge.startMs) / 1000));
                timeEl.textContent = this.formatDuration(sec);
            }, 250);
        },

        stopBridgeInterval() {
            if (this.bridgeIntervalId) {
                clearInterval(this.bridgeIntervalId);
                this.bridgeIntervalId = null;
            }
        },

        finalizeBridgeSetIfNeeded(exercise) {
            const isBridge = (exercise?.name ?? '').toString().trim().toLowerCase() === 'ponte';
            if (!isBridge) return null;
            if (!this.state.bridge?.running || this.state.bridge.exerciseId !== exercise.id) return null;

            const durationSec = Math.max(0, Math.floor((Date.now() - (this.state.bridge.startMs || Date.now())) / 1000));
            if (!this.state.bridge.durations) this.state.bridge.durations = {};
            if (!this.state.bridge.durations[exercise.id]) this.state.bridge.durations[exercise.id] = [];
            this.state.bridge.durations[exercise.id].push(durationSec);
            this.state.bridge.running = false;
            this.state.bridge.exerciseId = null;
            this.state.bridge.startMs = 0;
            this.saveAppState();
            this.stopBridgeInterval();

            const arr = this.state.bridge.durations[exercise.id];
            const max = arr.length ? Math.max(...arr) : durationSec;
            const avg = arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : durationSec;
            alert(`Ponte — Max: ${this.formatDuration(max)} — Media: ${this.formatDuration(avg)}`);
            return durationSec;
        },

        formatDuration(totalSeconds) {
            const s = Math.max(0, parseInt(totalSeconds, 10) || 0);
            const m = Math.floor(s / 60).toString().padStart(2, '0');
            const r = (s % 60).toString().padStart(2, '0');
            return `${m}:${r}`;
        },

        getHistory() {
            return JSON.parse(localStorage.getItem(STORAGE_KEYS.HISTORY)) || {};
        },

        saveHistory(history) {
            localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(history));
        },

        saveAppState() {
            localStorage.setItem(STORAGE_KEYS.APP_STATE, JSON.stringify(this.state));
        },

        loadAppState() {
            const state = localStorage.getItem(STORAGE_KEYS.APP_STATE);
            return state ? JSON.parse(state) : null;
        },

        renderFab() {
            const fabContainer = document.getElementById('fab-container');
            fabContainer.innerHTML = `
                <div class="fab" id="add-exercise-fab">+</div>
            `;
            document.getElementById('add-exercise-fab').onclick = () => {
                this.openFabMenu();
            };
        },

        openFabMenu() {
            this.ensureFabMenu();
            const modal = document.getElementById('fab-menu-modal');
            if (modal) modal.style.display = 'block';
        },

        ensureFabMenu() {
            if (document.getElementById('fab-menu-modal')) return;

            const modal = document.createElement('div');
            modal.id = 'fab-menu-modal';
            modal.className = 'modal';
            modal.innerHTML = `
                <div class="modal-content">
                    <span class="close-button" id="fab-menu-close">&times;</span>
                    <h2>Menu</h2>
                    <button type="button" id="fab-menu-add-exercise">Aggiungi Esercizio</button>
                    <button type="button" class="secondary" id="fab-menu-add-workout">Aggiungi Scheda</button>
                    <button type="button" class="secondary" id="fab-menu-manage-workouts">Gestisci Schede</button>
                    <button type="button" class="secondary" id="fab-menu-manage-exercises">Gestisci Esercizi</button>
                    <button type="button" class="secondary" id="fab-menu-records">Record Esercizi</button>
                </div>
            `;
            document.body.appendChild(modal);

            const close = () => {
                modal.style.display = 'none';
            };

            modal.querySelector('#fab-menu-close').onclick = close;
            modal.onclick = (event) => {
                if (event.target === modal) close();
            };

            modal.querySelector('#fab-menu-add-exercise').onclick = () => {
                close();
                const addExerciseModal = document.getElementById('add-exercise-modal');
                if (addExerciseModal) addExerciseModal.style.display = 'block';
            };

            modal.querySelector('#fab-menu-add-workout').onclick = () => {
                close();
                this.createWorkoutFlow();
            };

            modal.querySelector('#fab-menu-manage-workouts').onclick = () => {
                close();
                this.renderManageWorkouts();
            };

            modal.querySelector('#fab-menu-manage-exercises').onclick = () => {
                close();
                this.renderManageExercises();
            };

            modal.querySelector('#fab-menu-records').onclick = () => {
                close();
                this.renderExerciseRecordsBrowser();
            };
        },

        setupModal() {
            const modal = document.getElementById('add-exercise-modal');
            const closeButton = modal.querySelector('.close-button');

            closeButton.onclick = () => {
                modal.style.display = 'none';
            };

            window.onclick = (event) => {
                if (event.target == modal) {
                    modal.style.display = 'none';
                }
            };

            const form = document.getElementById('add-exercise-form');
            form.onsubmit = (event) => {
                event.preventDefault();
                this.saveNewExercise(form);
            };
        },

        async saveNewExercise(form) {
            const nameInput = form.querySelector('#exercise-name');
            const imageInput = form.querySelector('#exercise-image');
            const setsInput = form.querySelector('#exercise-default-sets');
            const repsInput = form.querySelector('#exercise-default-reps');
            const restInput = form.querySelector('#exercise-default-rest');
            const name = nameInput.value.trim();

            if (!name) {
                alert("Il nome dell'esercizio è obbligatorio.");
                return;
            }

            let imageBase64 = null;
            if (imageInput.files && imageInput.files[0]) {
                try {
                    imageBase64 = await this.readImageAsBase64(imageInput.files[0]);
                } catch (error) {
                    console.error('Error reading image file:', error);
                    alert("Errore durante la lettura dell'immagine.");
                    return;
                }
            }

            const newExercise = {
                id: `custom_${Date.now()}`,
                name: name,
                image: imageBase64,
                // Valori di default che l'utente potrà modificare in seguito
                default_sets: Math.max(1, parseInt(setsInput?.value, 10) || 3),
                default_reps: (repsInput?.value ?? '10').toString().trim() || '10',
                default_timer: Math.max(0, parseInt(restInput?.value, 10) || 60)
            };

            const customExercises = this.getCustomExercises();
            customExercises[newExercise.id] = newExercise;
            this.saveCustomExercises(customExercises);

            alert(`Esercizio "${name}" salvato!`);
            form.reset();
            document.getElementById('add-exercise-modal').style.display = 'none';
            // Refresh data to include the new exercise immediately
            this.loadData();
        },

        readImageAsBase64(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = error => reject(error);
                reader.readAsDataURL(file);
            });
        },

        getCustomExercises() {
            return JSON.parse(localStorage.getItem(STORAGE_KEYS.CUSTOM_EXERCISES)) || {};
        },

        saveCustomExercises(exercises) {
            localStorage.setItem(STORAGE_KEYS.CUSTOM_EXERCISES, JSON.stringify(exercises));
        },

        getSavedWorkouts() {
            const workouts = localStorage.getItem(STORAGE_KEYS.WORKOUTS);
            return workouts ? JSON.parse(workouts) : null;
        },

        saveWorkouts() {
            localStorage.setItem(STORAGE_KEYS.WORKOUTS, JSON.stringify(this.data.workouts));
        }
    };

    app.init();
});
