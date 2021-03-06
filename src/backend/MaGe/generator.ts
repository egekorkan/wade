'use strict';
import Combinatorics from 'js-combinatorics';
import _ from 'lodash';
import Crypto from 'crypto';
import * as Filters from './filters';
import * as Utils from './utils';
import { ThingDescription } from 'wot-typescript-definitions';
import { hrtime } from 'process';

/** generate all the possible combinations of interactions for a given list of things and a given length */
async function generateInteractionCombinations(generationForm: MAGE.GenerationFormInterace) {
    const things = generationForm.things;
    const filters = generationForm.filters;
    const templates = generationForm.templates;

    let events: MAGE.InputInteractionInterface[] = [];
    let propertyReads: MAGE.InputInteractionInterface[] = [];
    let propertyObservations: MAGE.InputInteractionInterface[] = [];
    let actionReads: MAGE.InputInteractionInterface[] = [];
    const propertyWrites: MAGE.InteractionInterface[] = [];
    const actions: MAGE.InteractionInterface[] = [];

    // get and categorize all input interactions
    things.inputs.forEach( thingDescription => {
        let forbiddenAnnotationFound =  false;
        if (!thingDescription.content) return;
        const parsedTd: ThingDescription = JSON.parse(thingDescription.content);
        let types: string | string[] | undefined = parsedTd['@type'];
        if (!types) types = [];
        if (typeof types === 'string') types = [types];
        for (const type of types) {
            if (filters.forbiddenTdAnnotations && filters.forbiddenTdAnnotations.some(a => a.annotation === type))
            forbiddenAnnotationFound = true; break;
        }
        if (!forbiddenAnnotationFound) {
            const interactions = getInputInteractions(parsedTd, filters);
            events.push(...interactions.events);
            propertyReads.push(...interactions.properties);
            actionReads.push(...interactions.actions);
            propertyObservations.push(...interactions.observations);
        }
    });

    // get and categorize all output interactions
    let forbiddenAnnotationFound =  false;
    things.outputs.forEach( thingDescription => {
        if (!thingDescription.content) return;
        const parsedTd: ThingDescription = JSON.parse(thingDescription.content);
        let types: string | string[] | undefined = parsedTd['@type'];
        if (!types) types = [];
        if (typeof types === 'string') types = [types];
        for (const type of types) {
            if (filters.forbiddenTdAnnotations && filters.forbiddenTdAnnotations.some(a => a.annotation === type))
            forbiddenAnnotationFound = true; break;
        }
        if (!forbiddenAnnotationFound) {
            const interactions = getOutputInteractions(parsedTd, filters);
            actions.push(...interactions.actions);
            propertyWrites.push(...interactions.properties);
        }
    });

    const outputs: MAGE.InteractionInterface[] = [];
    if (filters.acceptedOutputInteractionTypes.includes('property-write')) outputs.push(...propertyWrites);
    if (filters.acceptedOutputInteractionTypes.includes('action-invoke')) outputs.push(...actions);

    // for each input, get matching outputs based on filters
    async function getMatchingOutputCombinations(input: MAGE.InputInteractionInterface) {
        const matchingOutputs = await getMatchingOutputs(input, outputs, filters);
        const matchingOutputCombinations: MAGE.InteractionInterface[][] = [];
        for (let i = generationForm.minOutputs; i <= generationForm.maxOutputs; i++) {
            if (i > matchingOutputs.length) break;
            matchingOutputCombinations.push(...Combinatorics.bigCombination(matchingOutputs, i).toArray());
        }
        return matchingOutputCombinations;
    }

    for (const input of events) {
        input.matchingOutputCombinations = await getMatchingOutputCombinations(input);
    }
    for (const input of propertyReads) {
        input.matchingOutputCombinations = await getMatchingOutputCombinations(input);
    }
    for (const input of actionReads) {
        input.matchingOutputCombinations = await getMatchingOutputCombinations(input);
    }
    for (const input of propertyObservations) {
        input.matchingOutputCombinations = await getMatchingOutputCombinations(input);
    }
    // remove inputs without matching outputs
    events = events.filter(event => event.matchingOutputCombinations && event.matchingOutputCombinations.length > 0);
    propertyReads = propertyReads.filter(property => property.matchingOutputCombinations && property.matchingOutputCombinations.length > 0);
    actionReads = actionReads.filter(action => action.matchingOutputCombinations && action.matchingOutputCombinations.length > 0);
    propertyObservations = propertyObservations.filter(observation => observation.matchingOutputCombinations && observation.matchingOutputCombinations.length > 0);

    // Calculate all possible output combinations for each input combinations and put them together
    const interactionCombinations: MAGE.InteractionInterface[][] = [];

    const interactionsToCombine: MAGE.InputInteractionInterface[] = [];
    for (const template in templates) {
        switch (template) {
            case 'use-event-template':
                if (templates[template]) {
                    interactionsToCombine.push(...events);
                    interactionsToCombine.push(...propertyObservations);
                }
                break;
            case 'use-read-template': if (templates[template]) interactionsToCombine.push(...propertyReads); break;
            case 'use-action-template': if (templates[template]) interactionsToCombine.push(...actionReads); break;
        }
    }

    interactionCombinations.push(...getFinalCombinations(interactionsToCombine, generationForm));
    return interactionCombinations;
}

/** parse a TD to return all interactions that can serve as an input */
function getInputInteractions(thingDescription: ThingDescription, filters: MAGE.FiltersInterface) {
    const events: MAGE.InputInteractionInterface[] = [];
    const propertyReads: MAGE.InputInteractionInterface[] = [];
    const propertyObservations: MAGE.InputInteractionInterface[] = [];
    const actionReads: MAGE.InputInteractionInterface[] = [];
    for (const prop in thingDescription.properties) {
        let dontAddRead = false;
        let dontAddObserve = false;

        let propAnnotations = thingDescription.properties[prop]['@type'];
        if (!propAnnotations) propAnnotations = [];
        if (typeof propAnnotations === 'string') propAnnotations = [propAnnotations];

        // filter based on unwanted types
        if (!thingDescription.properties[prop].writeOnly) {
            if (!filters.acceptedTypes.includes(thingDescription.properties[prop].type)) {
                if (thingDescription.properties[prop].type) continue;
                else if (!thingDescription.properties[prop].type && !filters.acceptedTypes.includes('null')) continue;
            }
            // filter interactions with unwanted annotations
            if (filters.forbiddenAnnotations) {
                let forbiddenReadFound = false;
                let forbiddenObserveFound = false;
                for (const annotation of propAnnotations) {
                    if (filters.forbiddenAnnotations.some(a => a.annotation === annotation && a.type === 'property-read')) {
                        forbiddenReadFound = true;
                        break;
                    }
                }
                for (const annotation of propAnnotations) {
                    if (filters.forbiddenAnnotations.some(a => a.annotation === annotation && a.type === 'property-observe')) {
                        forbiddenObserveFound = true;
                        break;
                    }
                }
                if (forbiddenReadFound) dontAddRead = true;
                if (forbiddenObserveFound) dontAddObserve = true;
            }
            // filter unwanted interactions
            if (filters.forbiddenInteractions) {
                if (filters.forbiddenInteractions.some(inter => inter.thingId === thingDescription.id &&
                    inter.name === prop && inter.type === 'property-read')) dontAddRead = true;
                if (filters.forbiddenInteractions.some(inter => inter.thingId === thingDescription.id &&
                        inter.name === prop && inter.type === 'property-observe')) dontAddObserve = true;
            }
            if (!dontAddRead) propertyReads.push({
                interactionType: 'property-read',
                name: prop,
                object: thingDescription.properties[prop],
                from: 'Agent',
                to: thingDescription.title,
                thingId: thingDescription.id,
                id: ''
            });
            if (thingDescription.properties[prop].observable && !dontAddObserve) propertyObservations.push({
                interactionType: 'property-observe',
                name: prop,
                object: thingDescription.properties[prop],
                from: 'Agent',
                to: thingDescription.title,
                thingId: thingDescription.id,
                id: ''
            });
        }
    }
    for (const event in thingDescription.events) {

        let eventAnnotations = thingDescription.events[event]['@type'];
        if (!eventAnnotations) eventAnnotations = [];
        if (typeof eventAnnotations === 'string') eventAnnotations = [eventAnnotations];

        // filter based on accepted types
        if (!thingDescription.events[event].data && !filters.acceptedTypes.includes('null')) continue;
        else if (thingDescription.events[event].data && !filters.acceptedTypes.includes(thingDescription.events[event].data.type)) {
            if (thingDescription.events[event].data.type) continue;
            else if (!thingDescription.events[event].data.type && !filters.acceptedTypes.includes('null')) continue;
        }
        // filter interactions with unwanted annotations
        if (filters.forbiddenAnnotations) {
            let forbiddenFound = false;
            for (const annotation of eventAnnotations) {
                if (filters.forbiddenAnnotations.some(a => a.annotation === annotation && a.type === 'event-subscribe')) {
                    forbiddenFound = true;
                    break;
                }
            }
            if (forbiddenFound) continue;
        }
        // filter unwanted interactions
        if (filters.forbiddenInteractions) {
            if (filters.forbiddenInteractions.some(inter => inter.thingId === thingDescription.id &&
                inter.name === event && inter.type === 'event-subscribe')) continue;
        }
        events.push({
            interactionType: 'event-subscribe',
            name: event,
            object: thingDescription.events[event],
            from: 'Agent',
            to: thingDescription.title,
            thingId: thingDescription.id,
            id: ''
        });
    }
    for (const action in thingDescription.actions) {

        let actionAnnotations = thingDescription.actions[action]['@type'];
        if (!actionAnnotations) actionAnnotations = [];
        if (typeof actionAnnotations === 'string') actionAnnotations = [actionAnnotations];

        if (!thingDescription.actions[action].output && !filters.acceptedTypes.includes('null')) continue;
        else if (thingDescription.actions[action].output && !filters.acceptedTypes.includes(thingDescription.actions[action].output.type)) {
            if (thingDescription.actions[action].output.type) continue;
            else if (!thingDescription.actions[action].output.type && !filters.acceptedTypes.includes('null')) continue;
        }
        // filter interactions with unwanted annotations
        if (filters.forbiddenAnnotations) {
            let forbiddenFound = false;
            for (const annotation of actionAnnotations) {
                if (filters.forbiddenAnnotations.some(a => a.annotation === annotation && a.type === 'action-read')) {
                    forbiddenFound = true;
                    break;
                }
            }
            if (forbiddenFound) continue;
        }
        // filter unwanted interactions
        if (filters.forbiddenInteractions) {
            if (filters.forbiddenInteractions.some(inter => inter.thingId === thingDescription.id &&
                inter.name === action && inter.type === 'action-read')) continue;
        }
        actionReads.push({
            interactionType: 'action-read',
            name: action,
            object: thingDescription.actions[action],
            from: 'Agent',
            to: thingDescription.title,
            thingId: thingDescription.id,
            id: ''
        });
    }
    return { events, properties: propertyReads, actions: actionReads, observations: propertyObservations };
}

/** parse a TD to return all interactions that can serve as an output */
function getOutputInteractions(thingDescription, filters: MAGE.FiltersInterface) {
    const actions: MAGE.InteractionInterface[] = [];
    const propertyWrites: MAGE.InteractionInterface[] = [];
    for (const prop in thingDescription.properties) {

        let propAnnotations = thingDescription.properties[prop]['@type'];
        if (!propAnnotations) propAnnotations = [];
        if (typeof propAnnotations === 'string') propAnnotations = [propAnnotations];

        if (!thingDescription.properties[prop].readOnly) {
            // filter based on accepted types
            if (!filters.acceptedTypes.includes(thingDescription.properties[prop].type)) {
                if (thingDescription.properties[prop].type) continue;
                else if (!thingDescription.properties[prop].type && !filters.acceptedTypes.includes('null')) continue;
            }
            // filter interactions with unwanted annotations
            if (filters.forbiddenAnnotations) {
                let forbiddenFound = false;
                for (const annotation of propAnnotations) {
                    if (filters.forbiddenAnnotations.some(a => a.annotation === annotation && a.type === 'property-write')) {
                        forbiddenFound = true;
                        break;
                    }
                }
                if (forbiddenFound) continue;
            }
            // filter unwanted interactions
            if (filters.forbiddenInteractions) {
                if (filters.forbiddenInteractions.some(inter => inter.thingId === thingDescription.id &&
                    inter.name === prop && inter.type === 'property-write')) continue;
            }
            propertyWrites.push({
                interactionType: 'property-write',
                name: prop,
                object: thingDescription.properties[prop],
                from: 'Agent',
                to: thingDescription.title,
                id: Crypto.createHash('sha1').update(thingDescription.id + prop).digest('hex'),
                thingId: thingDescription.id
            });
        }
    }
    for (const action in thingDescription.actions) {

        let actionAnnotations = thingDescription.actions[action]['@type'];
        if (!actionAnnotations) actionAnnotations = [];
        if (typeof actionAnnotations === 'string') actionAnnotations = [actionAnnotations];

        if (!thingDescription.actions[action].input && !filters.acceptedTypes.includes('null')) continue;
        else if (thingDescription.actions[action].input && !filters.acceptedTypes.includes(thingDescription.actions[action].input.type)) {
            if (thingDescription.actions[action].input.type) continue;
            else if (!thingDescription.actions[action].input.type && !filters.acceptedTypes.includes('null')) continue;
        }
        // filter interactions with unwanted annotations
        if (filters.forbiddenAnnotations) {
            let forbiddenFound = false;
            for (const annotation of actionAnnotations) {
                if (filters.forbiddenAnnotations.some(a => a.annotation === annotation && a.type === 'action-invoke')) {
                    forbiddenFound = true;
                    break;
                }
            }
            if (forbiddenFound) continue;
        }
        // filter unwanted interactions
        if (filters.forbiddenInteractions) {
            if (filters.forbiddenInteractions.some(inter => inter.thingId === thingDescription.id &&
                inter.name === action && inter.type === 'action-invoke')) continue;
        }
        actions.push({
            interactionType: 'action-invoke',
            name: action,
            object: thingDescription.actions[action],
            from: 'Agent',
            to: thingDescription.title,
            id: Crypto.createHash('sha1').update(thingDescription.id + action).digest('hex'),
            thingId: thingDescription.id
        });
    }
    return { actions, properties: propertyWrites };
}

/** filter a list of outputs to match a given input (event or property_read) */
async function getMatchingOutputs(
    input: MAGE.InputInteractionInterface,
    outputs: MAGE.InteractionInterface[],
    filters: MAGE.FiltersInterface) {
        if (filters.onlySameType) {
            outputs = outputs.filter(element => Filters.sameType(input, element));
        }
        if (filters.onlySimilarNames && filters.similarityThresholdNames) {
            // since filter cannot by async, we have to filter manually.
            const newOutputs: MAGE.InteractionInterface[] = [];
            for (const element of outputs) {
                const filterResults = await Filters.similar(input, element, filters.similarityThresholdNames);
                if (filterResults) newOutputs.push(element);
            }
            return newOutputs;
        }
        if (filters.onlySimilarDescriptions && filters.similarityThresholdDescriptions) {
            // since filter cannot by async, we have to filter manually.
            const newOutputs: MAGE.InteractionInterface[] = [];
            for (const element of outputs) {
                const filterResults = await Filters.similarDescription((input.object as any).description,
                    (element.object as any).description, filters.similarityThresholdDescriptions);
                if (filterResults) newOutputs.push(element);
            }
            return newOutputs;
        }
        if (filters.semanticMatch) {
            outputs = outputs.filter(element => Filters.sameSemantics(input, element));
        }
    return outputs;
}
/** for a list of inputs, return all possible input/output combinations */
function getFinalCombinations(inputs: MAGE.InputInteractionInterface[], form: MAGE.GenerationFormInterace) {
    let interactionCombinations: MAGE.InteractionInterface[][] = [];
    // calculate all input combinations
    let allInputCombinations: MAGE.InputInteractionInterface[][] = [];
    for (let i = form.minInputs; i <= form.maxInputs; i++) {
        if (i > inputs.length) break;
        allInputCombinations.push(...Combinatorics.bigCombination(inputs, i).toArray());
    }
    // filter input combinations that have more things than allowed
    if (form.maxThings && form.maxThings > 0) allInputCombinations = allInputCombinations.filter(inputs_c => {if (form.maxThings) return getNumberOfThings(inputs_c) <= form.maxThings; });
    // filtering of mixed template inputs
    if (!form.filters.allowMixedTemplates)  allInputCombinations = allInputCombinations.filter(inputs_c => isMixedInputTemplate(inputs_c));
    // filter input based on must-have interactions
    if (form.filters.mustHaveInteractions && form.filters.mustHaveInteractions.length > 0) {
        interactionCombinations = interactionCombinations.filter(mashup => {if (form.filters.mustHaveInteractions) return mashupIncludesInteractions(mashup,
            form.filters.mustHaveInteractions.filter(i => i.type === 'property-read' || i.type === 'property-observe' || i.type === 'event-subscribe' || i.type === 'action-read')); });
    }
    // filter input based on must-have annotations
    if (form.filters.mustHaveAnnotations && form.filters.mustHaveAnnotations.length > 0) {
        interactionCombinations = interactionCombinations.filter(mashup => {if (form.filters.mustHaveAnnotations) return mashupIncludesAnnotations(mashup,
            form.filters.mustHaveAnnotations.filter(a => a.type === 'property-read' || a.type === 'property-observe' || a.type === 'event-subscribe' || a.type === 'action-read')); });
    }
    // filter input based on must-have TD annotations
    if (form.filters.mustHaveTdAnnotations && form.filters.mustHaveTdAnnotations.length > 0) {
        interactionCombinations = interactionCombinations.filter(mashup => {if (form.filters.mustHaveTdAnnotations) return mashupIncludesTdAnnotations(mashup,
            form.filters.mustHaveTdAnnotations.filter(a => a.type === 'input' || a.type === 'io'), form); });
    }

    allInputCombinations.forEach(inputs_c => {
        const availableOutputs: MAGE.InteractionInterface[][][] = [];
        inputs_c.forEach(input => {if (input.matchingOutputCombinations) availableOutputs.push(input.matchingOutputCombinations); });
        Utils.modifiedCartesianProduct(...availableOutputs)
        .filter(outputs_c => (outputs_c.length <= form.maxOutputs) && (outputs_c.length >= form.minOutputs))
        .forEach(outputs_c => {
            interactionCombinations.push([...inputs_c, ...outputs_c]);
        });
    });
    // filter final combinations that have more things than allowed
    if (form.maxThings && form.maxThings > 0) interactionCombinations = interactionCombinations.filter( mashup => {if (form.maxThings) return getNumberOfThings(mashup) <= form.maxThings; });
    // filter based on must-have interactions
    if (form.filters.mustHaveInteractions && form.filters.mustHaveInteractions.length > 0) {
        interactionCombinations = interactionCombinations.filter(mashup => {if (form.filters.mustHaveInteractions) return mashupIncludesInteractions(mashup, form.filters.mustHaveInteractions); });
    }
    // filter-based on must-have annotations
    if (form.filters.mustHaveAnnotations && form.filters.mustHaveAnnotations.length > 0) {
        interactionCombinations = interactionCombinations.filter(mashup => {if (form.filters.mustHaveAnnotations) return mashupIncludesAnnotations(mashup, form.filters.mustHaveAnnotations); });
    }
    // filter-based on must-have TD annotations
    if (form.filters.mustHaveTdAnnotations && form.filters.mustHaveTdAnnotations.length > 0) {
        interactionCombinations = interactionCombinations.filter(mashup => {if (form.filters.mustHaveTdAnnotations) return mashupIncludesTdAnnotations(mashup, form.filters.mustHaveTdAnnotations, form); });
    }
    return interactionCombinations;
}

function mashupIncludesInteractions(mashup: MAGE.InteractionInterface[], mustHaveInteractions: MAGE.VueInteractionInterface[]): boolean {
    let isIncluded: boolean = true;
    for (const mustHaveInteraction of mustHaveInteractions) {
        for (const [index, interaction] of mashup.entries()) {
            if (interaction.thingId ===  mustHaveInteraction.thingId && interaction.name === mustHaveInteraction.name &&
                interaction.interactionType === mustHaveInteraction.type) break;
            if (index === mashup.length - 1) isIncluded = false;
        }
    }
    return isIncluded;
}

function mashupIncludesTdAnnotations(
    mashup: MAGE.InteractionInterface[],
    mustHaveTdAnnotations: MAGE.VueAnnotationInterface[],
    form: MAGE.GenerationFormInterace): boolean {
        let isIncluded: boolean = true;
        for (const mustHaveTdAnnotation of mustHaveTdAnnotations) {
            innerloop: for (const [index, interaction] of mashup.entries()) {
                let resultTd: WADE.TDElementInterface | WADE.MashupElementInterface | undefined;
                let parsedTd = null;
                let types: string | string[] | undefined;
                switch (interaction.interactionType) {
                    case 'property-read':
                    case 'action-read':
                    case 'event-subscribe':
                        resultTd = form.things.inputs.find(td => {if (td.content) return JSON.parse(td.content).id === interaction.thingId; });
                        if (resultTd && resultTd.content) parsedTd = JSON.parse(resultTd.content);
                        if (parsedTd) types = parsedTd['@type'];
                        if (!types) types = [];
                        if (typeof types === 'string') types = [types];
                        if (types.includes(mustHaveTdAnnotation.annotation)) break innerloop;
                        break;

                    case 'property-write':
                    case 'action-invoke':
                        resultTd = form.things.outputs.find(td => {if (td.content) return JSON.parse(td.content).id === interaction.thingId; });
                        if (resultTd && resultTd.content) parsedTd = JSON.parse(resultTd.content);
                        if (parsedTd) types = parsedTd['@type'];
                        if (!types) types = [];
                        if (typeof types === 'string') types = [types];
                        if (types.includes(mustHaveTdAnnotation.annotation)) break innerloop;
                        break;
                }
                if (index === mashup.length - 1) isIncluded = false;
            }
            if (!isIncluded) return isIncluded;
        }
        return isIncluded;
}

function mashupIncludesAnnotations(mashup: MAGE.InteractionInterface[],
                                   mustHaveAnnotations: MAGE.VueAnnotationInterface[]): boolean {
        let isIncluded: boolean = true;
        for (const mustHaveAnnotation of mustHaveAnnotations) {
            for (const [index, interaction] of mashup.entries()) {
                let interactionAnnotations = interaction.object['@type'];
                if (!interactionAnnotations) interactionAnnotations = [];
                if (typeof interactionAnnotations === 'string') interactionAnnotations = [interactionAnnotations];
                if (interactionAnnotations.some(a => {return mustHaveAnnotation.annotation === a &&
                    mustHaveAnnotation.type === interaction.interactionType; })) break;
                if (index === mashup.length - 1) isIncluded = false;
            }
            if (!isIncluded) return isIncluded;
        }
        return isIncluded;
}

function isMixedInputTemplate(inputs: MAGE.InputInteractionInterface[]): boolean {
    let template: string = '';
    for (const [index, input] of inputs.entries()) {
        if (index === 0) {template = input.interactionType; continue; }
        if (input.interactionType !== template) return false;
        if (index === inputs.length - 1) return true;
    }
    return true;
}

/** Returns the number of Things that participate in a given list on interactions */
function getNumberOfThings(interactions: MAGE.InteractionInterface[]) {
    const thingIds: string[] = [];
    interactions.forEach(inter => {
        if (!thingIds.includes(inter.thingId)) thingIds.push(inter.thingId);
    });
    return thingIds.length;
}

/** Generate PlantUML textual code for a mashup
 *
 * @param {Array} interactions - Array of interaction (ie: a mashup)
 */
function generateMermaidSeqDiagram(mashupObject: {mashupName: string, interactions: MAGE.InteractionInterface[], numberOfInputInteractions: number, numberOfOutputInteractions: number}) {
    let seqDiagram = 'sequenceDiagram\n';
    const interactions = mashupObject.interactions;
    let inputsDone = 0;
    let outputsDone = 0;
    interactions.forEach( interaction => {
        // Determine interaction label and return path
        if (interaction.interactionType === 'property-read') {
            if (inputsDone == 0) seqDiagram += `par\n`;
            if (inputsDone > 0) seqDiagram += `and\n`;
            seqDiagram += `${interaction.from} ->>+ ${interaction.to} : readProperty: "${interaction.name}"\n`;
            inputsDone++;
        } else if (interaction.interactionType === 'action-read') {
            if (inputsDone == 0) seqDiagram += `par\n`;
            if (inputsDone > 0) seqDiagram += `and\n`;
            seqDiagram += `${interaction.from} ->>+ ${interaction.to} : invokeAction: "${interaction.name}"\n`;
            inputsDone++;
        } else if (interaction.interactionType === 'event-subscribe') {
            if (inputsDone == 0) seqDiagram += `par\n`;
            if (inputsDone > 0) seqDiagram += `and\n`;
            seqDiagram += `${interaction.from} ->>+ ${interaction.to} : subscribeEvent: "${interaction.name}"\n`;
            inputsDone++;
        } else if (interaction.interactionType === 'property-observe') {
            if (inputsDone == 0) seqDiagram += `par\n`;
            if (inputsDone > 0) seqDiagram += `and\n`;
            seqDiagram += `${interaction.from} ->>+ ${interaction.to} : observeProperty: "${interaction.name}"\n`;
            inputsDone++;
        } else if (interaction.interactionType === 'property-write') {
            if (outputsDone == 0) seqDiagram += `par\n`;
            if (outputsDone > 0) seqDiagram += `and\n`;
            seqDiagram += `${interaction.from} ->> ${interaction.to} : writeProperty: "${interaction.name}"\n`;
            outputsDone++;
            if (outputsDone == mashupObject.numberOfOutputInteractions) seqDiagram += `end\n`;
        } else if (interaction.interactionType === 'action-invoke') {
            if (outputsDone == 0) seqDiagram += `par\n`;
            if (outputsDone > 0) seqDiagram += `and\n`;
            seqDiagram += `${interaction.from} ->> ${interaction.to} : invokeAction: "${interaction.name}"\n`;
            outputsDone++;
            if (outputsDone == mashupObject.numberOfOutputInteractions) seqDiagram += `end\n`;
        }


        // determine return path
        if (interaction.interactionType === 'property-read') {
            seqDiagram += `${interaction.to} -->>- ${interaction.from} : response\n`;
            if (inputsDone == mashupObject.numberOfInputInteractions) seqDiagram += `end\n`;
        } else if (interaction.interactionType === 'event-subscribe' || interaction.interactionType === 'property-observe') {
            seqDiagram += `${interaction.to} -->> ${interaction.from} : confirmation\n`;
            seqDiagram += `${interaction.to} ->>- ${interaction.from} : data-pushed\n`;
            if (inputsDone == mashupObject.numberOfInputInteractions) seqDiagram += `end\n`;
        } else if (interaction.interactionType === 'action-read') {
            seqDiagram += `${interaction.to} -->>- ${interaction.from} : output\n`;
            if (inputsDone == mashupObject.numberOfInputInteractions) seqDiagram += `end\n`;
        }
    });
    seqDiagram += '\n';
    return seqDiagram;
}

function generatePlantUmlSeqDiagram(mashupObject: {mashupName: string, interactions: MAGE.InteractionInterface[], numberOfInputInteractions: number, numberOfOutputInteractions: number}) {
    let seqDiagram = `@startuml ${mashupObject.mashupName}\n`;
    seqDiagram += `[->"Agent": top:${mashupObject.mashupName}()\nactivate "Agent"\n`;
    seqDiagram += 'group strict\n';
    const interactions = mashupObject.interactions;
    let inputsDone = 0;
    let outputsDone = 0;
    interactions.forEach( interaction => {
        // Determine interaction label and return path
        if (interaction.interactionType === 'property-read') {
            if (inputsDone == 0) seqDiagram += `par\n`;
            if (inputsDone > 0) seqDiagram += `else\n`;
            seqDiagram += `"${interaction.from}" -> "${interaction.to}" : readProperty: "${interaction.name}"\n`;
            seqDiagram += `activate "${interaction.to}"\n`;
            inputsDone++;
        } else if (interaction.interactionType === 'action-read') {
            if (inputsDone == 0) seqDiagram += `par\n`;
            if (inputsDone > 0) seqDiagram += `else\n`;
            seqDiagram += `"${interaction.from}" -> "${interaction.to}" : invokeAction: "${interaction.name}"\n`;
            seqDiagram += `activate "${interaction.to}"\n`;
            inputsDone++;
        } else if (interaction.interactionType === 'event-subscribe') {
            if (inputsDone == 0) seqDiagram += `par\n`;
            if (inputsDone > 0) seqDiagram += `else\n`;
            seqDiagram += `"${interaction.from}" -> "${interaction.to}" : subscribeEvent: "${interaction.name}"\n`;
            seqDiagram += `activate "${interaction.to}"\n`;
            inputsDone++;
        } else if (interaction.interactionType === 'property-observe') {
            if (inputsDone == 0) seqDiagram += `par\n`;
            if (inputsDone > 0) seqDiagram += `else\n`;
            seqDiagram += `"${interaction.from}" -> "${interaction.to}" : observeProperty: "${interaction.name}"\n`;
            seqDiagram += `activate "${interaction.to}"\n`;
            inputsDone++;
        } else if (interaction.interactionType === 'property-write') {
            if (outputsDone == 0) seqDiagram += `par\n`;
            if (outputsDone > 0) seqDiagram += `else\n`;
            seqDiagram += `"${interaction.from}" -> "${interaction.to}" : writeProperty: "${interaction.name}"\n`;
            outputsDone++;
            if (outputsDone == mashupObject.numberOfOutputInteractions) seqDiagram += `end\n`;
        } else if (interaction.interactionType === 'action-invoke') {
            if (outputsDone == 0) seqDiagram += `par\n`;
            if (outputsDone > 0) seqDiagram += `else\n`;
            seqDiagram += `"${interaction.from}" -> "${interaction.to}" : invokeAction: "${interaction.name}"\n`;
            outputsDone++;
            if (outputsDone == mashupObject.numberOfOutputInteractions) seqDiagram += `end\n`;
        }


        // determine return path
        if (interaction.interactionType === 'property-read') {
            seqDiagram += `"${interaction.to}" --> "${interaction.from}" : response\n`;
            seqDiagram += `deactivate "${interaction.to}"\n`;
            if (inputsDone == mashupObject.numberOfInputInteractions) seqDiagram += `end\n`;
        } else if (interaction.interactionType === 'event-subscribe' || interaction.interactionType === 'property-observe') {
            seqDiagram += `"${interaction.to}" --> "${interaction.from}" : confirmation\n`;
            seqDiagram += `"${interaction.to}" ->> "${interaction.from}" : data-pushed\n`;
            if (inputsDone == mashupObject.numberOfInputInteractions) seqDiagram += `end\n`;
        } else if (interaction.interactionType === 'action-read') {
            seqDiagram += `"${interaction.to}" --> "${interaction.from}" : response\n`;
            seqDiagram += `deactivate "${interaction.to}"\n`;
            if (inputsDone == mashupObject.numberOfInputInteractions) seqDiagram += `end\n`;
        }
    });
    seqDiagram += `end\n[<-"Agent"\ndeactivate "Agent"\n`;
    seqDiagram += '@enduml\n';
    return seqDiagram;
}

/** calculate size of design space ( how many mashups would be possible without any rules or filters ) */
function getDesignSpaceSize(generationForm: MAGE.GenerationFormInterace) {
    let designSpaceSize = 0;
    let nInputs = 0;
    let nOutputs = 0;
    const things = generationForm.things;

    const tdIds: string[] = [];
    const uniqueTds: WADE.TDElementInterface[] = [];
    things.inputs.concat(things.outputs).forEach(td => {
        if (!tdIds.includes(td.id)) {
            uniqueTds.push(td);
            tdIds.push(td.id);
        }
    });

    things.inputs.forEach(element => {
        let parsedTd: ThingDescription;
        if (!element.content) return;
        parsedTd = JSON.parse(element.content);
        for (const prop in parsedTd.properties) {
            if (parsedTd.properties[prop].writeOnly) continue;
            nInputs++;
            if (parsedTd.properties[prop].observable) nInputs++;
        }
        if (parsedTd.actions) nInputs += Object.keys(parsedTd.actions).length;
        if (parsedTd.events) nInputs += Object.keys(parsedTd.events).length;
    });

    things.outputs.forEach(element => {
        let parsedTd: ThingDescription;
        if (!element.content) return;
        parsedTd = JSON.parse(element.content);
        for (const prop in parsedTd.properties) {
            if (parsedTd.properties[prop].readOnly) continue;
            nOutputs++;
        }
        if (parsedTd.actions) nOutputs += Object.keys(parsedTd.actions).length;
    });

    let max_k = generationForm.maxInputs + generationForm.maxOutputs;
    const min_k =  generationForm.minInputs + generationForm.minOutputs;
    const nTotal = nInputs + nOutputs;
    if (max_k > nTotal) max_k = nTotal;
    for (let i = generationForm.minInputs; i <= generationForm.maxInputs; i++) {
        for (let j = generationForm.minOutputs; j <= generationForm.maxOutputs; j++)
        designSpaceSize += (Utils.factorial(nInputs) * Utils.factorial(nOutputs)) / (Utils.factorial(i) * Utils.factorial(j) * Utils.factorial(nInputs - i) * Utils.factorial(nOutputs - j));
    }

    return Math.round(designSpaceSize);
}

/** Main function to generate mashups. Calls all other functions. */
export default async function generateMashups(generationForm: MAGE.GenerationFormInterace) {
    // let start = hrtime.bigint();
    const start = hrtime();
    const interactionCombinations = await generateInteractionCombinations(generationForm);
    const designSpaceSize = getDesignSpaceSize(generationForm);

    const imagesMDs: string[] = [];
    const plantUmls: string[] = [];
    for (const combi of interactionCombinations) {
        let numberOfInputInteractions = 0;
        let numberOfOutputInteractions = 0;
        for (const interaction of combi) {
            switch (interaction.interactionType) {
                case 'property-read':
                case 'event-subscribe':
                case 'action-read':
                case 'property-observe':
                    numberOfInputInteractions++; break;
                case 'property-write':
                case 'action-invoke':
                    numberOfOutputInteractions++; break;
            }
        }
        const combiObject = {
            mashupName: generationForm.mashupName,
            interactions: combi,
            numberOfInputInteractions,
            numberOfOutputInteractions
        };
        const mermaidUml = generateMermaidSeqDiagram(combiObject);
        imagesMDs.push(mermaidUml);
        const plantUml = generatePlantUmlSeqDiagram(combiObject);
        plantUmls.push(plantUml);
    }

    const end = hrtime(start);
    // let end = hrtime.bigint();
    const totalMashups =  interactionCombinations.length;

    const results = {
        designSpaceSize,
        mashupsGenerated: totalMashups,
        imagesMDs,
        plantUmls,
        mashups: interactionCombinations,
        executionTime: end
    };

    return results;
}

/**
 * Class
 */
export class GenerationForm implements MAGE.GenerationFormInterace {
    public mashupName: string;
    public things: {
        inputs: WADE.TDElementInterface[]
        outputs: WADE.TDElementInterface[]
    };
    public minInputs: number;
    public  maxInputs: number;
    public  minOutputs: number;
    public  maxOutputs: number;
    public  maxThings: number | null;
    public  templates: {
        'use-event-template': boolean;
        'use-action-template': boolean;
        'use-read-template': boolean;
    };
    public filters: {
          acceptedTypes: string[],
          allowMixedTemplates: boolean,
          acceptedOutputInteractionTypes: string[],
          onlySameType: boolean,
          onlySimilarNames: boolean,
          onlySimilarDescriptions: boolean,
          similarityThresholdNames: number | null,
          similarityThresholdDescriptions: number | null,
          semanticMatch: boolean
    };
    public generation: {
          generateCode: boolean,
          includeFunctionSkeletons: boolean
    };
    constructor() {
        this.mashupName = '';
        this.things = {
            inputs: [],
            outputs: [],
        };
        this.minInputs = 1,
        this.maxInputs = 1,
        this.minOutputs = 1,
        this.maxOutputs = 1,
        this.maxThings = null,
        this.templates = {
            'use-event-template': true,
            'use-action-template': false,
            'use-read-template': true,
        },
        this.filters = {
            acceptedTypes: [],
            acceptedOutputInteractionTypes: [],
            onlySameType: false,
            onlySimilarNames: false,
            onlySimilarDescriptions: false,
            similarityThresholdNames: null,
            similarityThresholdDescriptions: null,
            semanticMatch: false,
            allowMixedTemplates: false,

        },
        this.generation = {
            generateCode: false,
            includeFunctionSkeletons: false
        };
    }
}
