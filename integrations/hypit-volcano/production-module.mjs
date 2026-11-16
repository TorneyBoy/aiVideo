// Original aiVideo surfaces using Hypit's public graph/model APIs. No WhisperX service is selected.
import { sealGraphFragment } from '@hypit/hypit/author';
import { createMarkupSurfaceFacet } from '@hypit/hypit/markup';
import { createProducerPackageFacet, plannedNeedInputs } from '@hypit/hypit/producer';
import { createAdmissionPackageFacet } from '@hypit/hypit/admission';
import { blobTypes } from '@hypit/hypit/blob';
import { textTypes } from '@hypit/hypit/text';
import { canonicalize } from '@hypit/hypit/protocol';
import { sealGenerationPortTable, sealGenerationRequestDraft, sealGenerationMediaBinding } from '@hypit/generation';
import { defineExactModelModule, createExactModelPrimaryGenerationFragment, exactModelMediaInputNames, exactModelTextInputName } from '@hypit/generation/model';
import { narrativeTypes, narrativeDependency } from '@hypit/narrative';
import { mediaTypes, mediaDependency } from '@hypit/media';
import { temporalTypes, temporalDependency } from '@hypit/temporal';
import { narrativeTemporalTypes, narrativeTemporalDependency } from '@hypit/narrative-temporal';
import { speechEvidenceTypes, speechEvidenceProducers, speechEvidenceDependency, assertSpeechEvidenceAudioIdentity } from '@hypit/speech-evidence';
import { speechAlignmentProducers, speechAlignmentModuleRef } from '@hypit/narrative-speech-alignment';

export const productionModuleRef = { name: '@aivideo/hypit-volcano', version: '1' };
const ports = sealGenerationPortTable({ model: 'volcano-image-edit', result: 'image', ports: [
  { name: 'prompt', value: { kind: 'text', maxChars: 5000 }, minItems: 1, maxItems: 1 },
  { name: 'aspectRatio', value: { kind: 'text', maxChars: 20 }, minItems: 1, maxItems: 1 },
  { name: 'size', value: { kind: 'enum', values: ['2K', '4K'] }, minItems: 1, maxItems: 1 },
  { name: 'images', value: { kind: 'media', accepts: ['image'] }, minItems: 1, maxItems: 10 },
], requires: [] });
const imageDefinition = defineExactModelModule({ module: productionModuleRef, endpoints: [{ key: 'image', requestTypeName: 'VolcanoImageRequest', producerName: 'request-volcano-image', ports }] });
export const imageEndpoint = imageDefinition.endpoints.image;
export const wordCapability = { module: productionModuleRef, name: 'doubao-word-evidence' };
const requestWords = { module: productionModuleRef, name: 'request-doubao-words' };
const dependencyMap = new Map([...imageDefinition.manifest.dependencies, narrativeDependency, mediaDependency, temporalDependency, narrativeTemporalDependency, speechEvidenceDependency, { module: speechAlignmentModuleRef }].map(item => [JSON.stringify(item.module), item]));
export const productionManifest = {
  ...imageDefinition.manifest, dependencies: [...dependencyMap.values()],
  capabilities: [...imageDefinition.manifest.capabilities, { name: wordCapability.name, returns: speechEvidenceTypes.alignedTranscript }],
  producers: [...imageDefinition.manifest.producers, { name: requestWords.name, inputs: [{ name: 'evidence', type: speechEvidenceTypes.audio }, { name: 'label', type: textTypes.text }], outputs: [], needs: [{ name: 'words', capability: wordCapability, returns: speechEvidenceTypes.alignedTranscript }] }],
};
const wordComponent = { producers: [{ producer: requestWords, handler({ inputs }) {
  const evidence = inputs.evidence?.value;
  if (evidence?.kind !== 'inline') throw new Error('Doubao alignment requires projected speech evidence');
  assertSpeechEvidenceAudioIdentity(evidence.value);
  const label = inputs.label?.value;
  if (label?.kind !== 'inline' || typeof label.value?.value !== 'string') throw new Error('Doubao alignment needs an authored label');
  return { outputs: {}, needs: { words: canonicalize({ domainId: evidence.value.domainId, audio: evidence.value.artifact, sampleFrames: evidence.value.sampleFrames, label: label.value.value }) } };
} }], plannedNeeds: [{ producer: requestWords, port: 'words', capability: wordCapability,
  plan({ state, step }) { return { constraints: {}, pendingInputs: plannedNeedInputs(state, step, { evidence: 'audio' }) }; },
}] };

const input = name => ({ kind: 'fragment-input', name });
const operation = id => ({ kind: 'fragment-operation', operation: id });
const alignment = sealGraphFragment({
  inputs: [{ name: 'narrative', type: narrativeTypes.narrative }, { name: 'segment', type: narrativeTypes.segmentRef }, { name: 'media', type: mediaTypes.synchronized }, { name: 'domain', type: temporalTypes.localDomain }, { name: 'label', type: textTypes.text }],
  operations: [
    { id: 'audio', producer: speechEvidenceProducers.projectAudio, inputs: { media: input('media'), domain: input('domain') }, result: { kind: 'need', name: 'evidenceAudio' } },
    { id: 'words', producer: requestWords, inputs: { evidence: operation('audio'), label: input('label') }, result: { kind: 'need', name: 'words' } },
    { id: 'alignment', producer: speechAlignmentProducers.alignNarrative, inputs: { narrative: input('narrative'), segment: input('segment'), domain: input('domain'), evidence: operation('words') }, result: { kind: 'output', name: 'alignment' } },
  ], exports: [{ name: 'alignment', type: narrativeTemporalTypes.narrativeAlignment, root: operation('alignment') }],
});

function text(element, name) {
  const value = element.attributes[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${element.name}.${name} must be text`);
  return value;
}
function ref(element, name, type, resolveReference) {
  const attribute = element.attributes[name];
  if (attribute?.kind !== 'reference') throw new Error(`${element.name}.${name} requires a reference`);
  const value = resolveReference(attribute.path);
  if (!value || JSON.stringify(value.type) !== JSON.stringify(type)) {
    if (!value || value.type.name !== type.name || value.type.module.name !== type.module.name || value.type.module.version !== type.module.version) throw new Error(`${element.name}.${name} has the wrong type`);
  }
  return value;
}
function exact(element, names) {
  if (Object.keys(element.attributes).some(name => !names.includes(name))) throw new Error(`${element.name} has unsupported attributes`);
}
const imageSurface = { name: 'camera-image', tag: 'CameraImage', mode: 'structured', outputs: [imageEndpoint.draftType, imageEndpoint.mediaBindings.images.type] };
const alignmentSurface = { name: 'alignment', tag: 'Alignment', mode: 'structured', outputs: [narrativeTemporalTypes.narrativeAlignment, textTypes.text] };
function decodeImage({ element, resolveReference }) {
  exact(element, ['id', 'prompt', 'aspect-ratio', 'size']);
  const id = text(element, 'id');
  const prompt = ref(element, 'prompt', textTypes.text, resolveReference);
  const records = [{ id: `${id}.draft`, type: imageEndpoint.draftType, value: { kind: 'inline', value: sealGenerationRequestDraft(ports, { aspectRatio: [text(element, 'aspect-ratio')], size: [text(element, 'size')] }) }, range: element.range }];
  const inputs = { draft: { kind: 'record', id: `${id}.draft` }, [exactModelTextInputName('prompt')]: prompt.ref };
  const media = [];
  for (const child of element.children) {
    if (child.kind === 'text') { if (child.value.trim()) throw new Error('CameraImage accepts Reference children'); continue; }
    if (child.name.split(':').at(-1) !== 'Reference') throw new Error('CameraImage accepts Reference children');
    exact(child, ['image']);
    const artifact = ref(child, 'image', blobTypes.blob, resolveReference);
    const name = `image-${media.length + 1}`, binding = `${id}.${name}`;
    records.push({ id: binding, type: imageEndpoint.mediaBindings.images.type, value: { kind: 'inline', value: sealGenerationMediaBinding(ports.ports.find(port => port.name === 'images'), { role: 'image' }) }, range: child.range });
    const names = exactModelMediaInputNames(name);
    inputs[names.binding] = { kind: 'record', id: binding }; inputs[names.artifact] = artifact.ref;
    media.push({ name, port: 'images' });
  }
  if (!media.length || media.length > 10) throw new Error('CameraImage needs 1–10 references');
  const fragment = createExactModelPrimaryGenerationFragment(imageEndpoint, media, [{ name: 'prompt', port: 'prompt' }]);
  return { records, fragments: [fragment], components: [{ id, fragment: fragment.id, inputs, outputs: { image: `${id}.image` }, range: element.range }] };
}
function decodeAlignment({ element, resolveReference }) {
  exact(element, ['id', 'narrative', 'segment', 'media', 'domain']);
  const id = text(element, 'id');
  const types = { narrative: narrativeTypes.narrative, segment: narrativeTypes.segmentRef, media: mediaTypes.synchronized, domain: temporalTypes.localDomain };
  const inputs = Object.fromEntries(Object.entries(types).map(([name, type]) => [name, ref(element, name, type, resolveReference).ref]));
  inputs.label = { kind: 'record', id: `${id}.label` };
  return { records: [{ id: `${id}.label`, type: textTypes.text, value: { kind: 'inline', value: { value: id } }, range: element.range }], fragments: [alignment], components: [{ id, fragment: alignment.id, inputs, outputs: { alignment: `${id}.alignment` }, range: element.range }] };
}
export const productionFacets = [
  createProducerPackageFacet(imageDefinition.component), createAdmissionPackageFacet(imageDefinition.component), imageDefinition.facet,
  createProducerPackageFacet(wordComponent), createAdmissionPackageFacet(wordComponent),
  createMarkupSurfaceFacet({ module: productionModuleRef, declaration: imageSurface, handler: decodeImage }),
  createMarkupSurfaceFacet({ module: productionModuleRef, declaration: alignmentSurface, handler: decodeAlignment }),
];
