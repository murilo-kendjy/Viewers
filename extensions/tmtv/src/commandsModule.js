import { vec3 } from 'gl-matrix';
import OHIF from '@ohif/core';
import * as cs from '@cornerstonejs/core';
import * as csTools from '@cornerstonejs/tools';
import { classes } from '@ohif/core';
import getThresholdValues from './utils/getThresholdValue';
import calculateSuvPeak from './utils/calculateSUVPeak';
import calculateTMTV from './utils/calculateTMTV';
import createAndDownloadTMTVReport from './utils/createAndDownloadTMTVReport';

import dicomRTAnnotationExport from './utils/dicomRTAnnotationExport/RTStructureSet';

const metadataProvider = classes.MetadataProvider;
const RECTANGLE_ROI_THRESHOLD_MANUAL = 'RectangleROIStartEndThreshold';

const commandsModule = ({
  servicesManager,
  commandsManager,
  extensionManager,
}) => {
  const {
    ViewportGridService,
    UINotificationService,
    DisplaySetService,
    HangingProtocolService,
    ToolGroupService,
    CornerstoneViewportService,
  } = servicesManager.services;

  const utilityModule = extensionManager.getModuleEntry(
    '@ohif/extension-cornerstone.utilityModule.common'
  );

  const { getEnabledElement } = utilityModule.exports;

  function _getActiveViewportsEnabledElement() {
    const { activeViewportIndex } = ViewportGridService.getState();
    const { element } = getEnabledElement(activeViewportIndex) || {};
    const enabledElement = cs.getEnabledElement(element);
    return enabledElement;
  }

  function _getMatchedViewportsToolGroupIds() {
    const [matchedViewports] = HangingProtocolService.getState();
    const toolGroupIds = [];
    matchedViewports.forEach(({ viewportOptions }) => {
      const { toolGroupId } = viewportOptions;
      if (toolGroupIds.indexOf(toolGroupId) === -1) {
        toolGroupIds.push(toolGroupId);
      }
    });

    return toolGroupIds;
  }

  const actions = {
    getMatchingPTDisplaySet: () => {
      // Todo: this is assuming that the hanging protocol has successfully matched
      // the correct PT. For future, we should have a way to filter out the PTs
      // that are in the viewer layout (but then we have the problem of the attenuation
      // corrected PT vs the non-attenuation correct PT)
      const matches = HangingProtocolService.getDisplaySetsMatchDetails();

      const matchedSeriesInstanceUIDs = Array.from(matches.values()).map(
        ({ SeriesInstanceUID }) => SeriesInstanceUID
      );

      let ptDisplaySet = null;
      for (const SeriesInstanceUID of matchedSeriesInstanceUIDs) {
        const displaySets = DisplaySetService.getDisplaySetsForSeries(
          SeriesInstanceUID
        );

        if (!displaySets || displaySets.length === 0) {
          continue;
        }

        const displaySet = displaySets[0];
        if (displaySet.Modality !== 'PT') {
          continue;
        }

        ptDisplaySet = displaySet;
      }

      return ptDisplaySet;
    },
    getPTMetadata: ({ ptDisplaySet }) => {
      const dataSource = extensionManager.getDataSources()[0];
      const imageIds = dataSource.getImageIdsForDisplaySet(ptDisplaySet);

      const firstImageId = imageIds[0];
      const instance = metadataProvider.get('instance', firstImageId);
      if (instance.Modality !== 'PT') {
        return;
      }

      const metadata = {
        SeriesTime: instance.SeriesTime,
        Modality: instance.Modality,
        PatientSex: instance.PatientSex,
        PatientWeight: instance.PatientWeight,
        RadiopharmaceuticalInformationSequence: {
          RadionuclideTotalDose:
            instance.RadiopharmaceuticalInformationSequence[0]
              .RadionuclideTotalDose,
          RadionuclideHalfLife:
            instance.RadiopharmaceuticalInformationSequence[0]
              .RadionuclideHalfLife,
          RadiopharmaceuticalStartTime:
            instance.RadiopharmaceuticalInformationSequence[0]
              .RadiopharmaceuticalStartTime,
          RadiopharmaceuticalStartDateTime:
            instance.RadiopharmaceuticalInformationSequence[0]
              .RadiopharmaceuticalStartDateTime,
        },
      };

      return metadata;
    },
    createNewLabelmapFromPT: async () => {
      // Create a segmentation of the same resolution as the source data
      // using volumeLoader.createAndCacheDerivedVolume.
      const ptDisplaySet = actions.getMatchingPTDisplaySet();

      if (!ptDisplaySet) {
        UINotificationService.error('No matching PT display set found');
        return;
      }

      const segmentationId = await commandsManager.runCommand(
        'createSegmentationForDisplaySet',
        {
          displaySetInstanceUID: ptDisplaySet.displaySetInstanceUID,
        }
      );

      const toolGroupIds = _getMatchedViewportsToolGroupIds();

      const representationType =
        csTools.Enums.SegmentationRepresentations.Labelmap;

      for (const toolGroupId of toolGroupIds) {
        await commandsManager.runCommand(
          'addSegmentationRepresentationToToolGroup',
          { segmentationId, toolGroupId: toolGroupId, representationType }
        );
      }

      return segmentationId;
    },
    setSegmentationActiveForToolGroups: ({ segmentationId }) => {
      const toolGroupIds = _getMatchedViewportsToolGroupIds();

      toolGroupIds.forEach(toolGroupId => {
        const segmentationRepresentations = csTools.segmentation.state.getSegmentationRepresentations(
          toolGroupId
        );

        if (segmentationRepresentations.length === 0) {
          return;
        }

        // Todo: this finds the first segmentation representation that matches the segmentationId
        // If there are two labelmap representations from the same segmentation, this will not work
        const representation = segmentationRepresentations.find(
          representation => representation.segmentationId === segmentationId
        );

        csTools.segmentation.activeSegmentation.setActiveSegmentationRepresentation(
          toolGroupId,
          representation.segmentationRepresentationUID
        );
      });
    },
    thresholdSegmentationByRectangleROITool: ({ segmentationId, config }) => {
      const segmentation = csTools.segmentation.state.getSegmentation(
        segmentationId
      );

      const { representationData } = segmentation;
      const { volumeId: segVolumeId } = representationData[
        csTools.Enums.SegmentationRepresentations.Labelmap
      ];

      const { referencedVolumeId } = cs.cache.getVolume(segVolumeId);

      const labelmapVolume = cs.cache.getVolume(segmentationId);
      const referencedVolume = cs.cache.getVolume(referencedVolumeId);

      if (!referencedVolume) {
        throw new Error('No Reference volume found');
      }

      if (!labelmapVolume) {
        throw new Error('No Reference labelmap found');
      }

      const annotationUIDs = csTools.annotation.selection.getAnnotationsSelectedByToolName(
        RECTANGLE_ROI_THRESHOLD_MANUAL
      );

      if (annotationUIDs.length === 0) {
        UINotificationService.show({
          title: 'Commands Module',
          message: 'No ROIThreshold Tool is Selected',
          type: 'error',
        });
        return;
      }

      const { lower, upper } = getThresholdValues(
        annotationUIDs,
        referencedVolume,
        config
      );

      const configToUse = {
        lower,
        upper,
        overwrite: true,
      };

      return csTools.utilities.segmentation.rectangleROIThresholdVolumeByRange(
        annotationUIDs,
        labelmapVolume,
        [referencedVolume],
        configToUse
      );
    },
    toggleSegmentationVisibility: ({ segmentationId }) => {
      const toolGroupIds = _getMatchedViewportsToolGroupIds();

      toolGroupIds.forEach(toolGroupId => {
        const segmentationRepresentations = csTools.segmentation.state.getSegmentationRepresentations(
          toolGroupId
        );

        if (segmentationRepresentations.length === 0) {
          return;
        }

        // Todo: this finds the first segmentation representation that matches the segmentationId
        // If there are two labelmap representations from the same segmentation, this will not work
        const representation = segmentationRepresentations.find(
          representation => representation.segmentationId === segmentationId
        );

        const visibility = csTools.segmentation.config.visibility.getSegmentationVisibility(
          toolGroupId,
          representation.segmentationRepresentationUID
        );

        csTools.segmentation.config.visibility.setSegmentationVisibility(
          toolGroupId,
          representation.segmentationRepresentationUID,
          !visibility
        );
      });
    },
    calculateSuvPeak: ({ labelmap }) => {
      const { referencedVolumeId } = labelmap;

      const referencedVolume = cs.cache.getVolume(referencedVolumeId);

      const annotationUIDs = csTools.annotation.selection.getAnnotationsSelectedByToolName(
        RECTANGLE_ROI_THRESHOLD_MANUAL
      );

      const annotations = annotationUIDs.map(annotationUID =>
        csTools.annotation.state.getAnnotation(annotationUID)
      );

      const suvPeak = calculateSuvPeak(labelmap, referencedVolume, annotations);
      return {
        suvPeak: suvPeak.mean,
        suvMax: suvPeak.max,
        suvMaxIJK: suvPeak.maxIJK,
        suvMaxLPS: suvPeak.maxLPS,
      };
    },
    getLesionStats: ({ labelmap, segmentIndex = 1 }) => {
      const { scalarData, spacing } = labelmap;

      const { scalarData: referencedScalarData } = cs.cache.getVolume(
        labelmap.referencedVolumeId
      );

      let segmentationMax = -Infinity;
      let segmentationMin = Infinity;
      let segmentationValues = [];

      let voxelCount = 0;
      for (let i = 0; i < scalarData.length; i++) {
        if (scalarData[i] === segmentIndex) {
          const value = referencedScalarData[i];
          segmentationValues.push(value);
          if (value > segmentationMax) {
            segmentationMax = value;
          }
          if (value < segmentationMin) {
            segmentationMin = value;
          }
          voxelCount++;
        }
      }

      const stats = {
        minValue: segmentationMin,
        maxValue: segmentationMax,
        meanValue: segmentationValues.reduce((a, b) => a + b, 0) / voxelCount,
        stdValue: Math.sqrt(
          segmentationValues.reduce((a, b) => a + b * b, 0) / voxelCount -
            segmentationValues.reduce((a, b) => a + b, 0) / voxelCount ** 2
        ),
        volume: voxelCount * spacing[0] * spacing[1] * spacing[2] * 1e-3,
      };

      return stats;
    },
    calculateLesionGlycolysis: ({ lesionStats }) => {
      const { meanValue, volume } = lesionStats;

      return {
        lesionGlyoclysisStats: volume * meanValue,
      };
    },
    calculateTMTV: ({ segmentations }) => {
      const labelmaps = commandsManager.runCommand('getLabelmapVolumes', {
        segmentations,
      });

      if (!labelmaps.length) {
        return;
      }

      return calculateTMTV(labelmaps);
    },
    exportTMTVReportCSV: ({ segmentations, tmtv, config }) => {
      const segReport = commandsManager.runCommand('getSegmentationCSVReport', {
        segmentations,
      });

      const tlg = actions.getTotalLesionGlycolysis({ segmentations });
      const additionalReportRows = [
        { key: 'Total Metabolic Tumor Volume', value: { tmtv } },
        { key: 'Total Lesion Glycolysis', value: { tlg: tlg.toFixed(4) } },
        { key: 'Threshold Configuration', value: { ...config } },
      ];

      createAndDownloadTMTVReport(segReport, additionalReportRows);
    },
    getTotalLesionGlycolysis: ({ segmentations }) => {
      const labelmapVolumes = commandsManager.runCommand('getLabelmapVolumes', {
        segmentations,
      });

      let mergedLabelmap;
      // merge labelmap will through an error if labels maps are not the same size
      // or same direction or ....
      try {
        mergedLabelmap = csTools.utilities.segmentation.createMergedLabelmapForIndex(
          labelmapVolumes
        );
      } catch (e) {
        console.error('commandsModule::getTotalLesionGlycolysis', e);
        return;
      }

      // grabbing the first labelmap referenceVolume since it will be the same for all
      const { referencedVolumeId, spacing } = labelmapVolumes[0];

      if (!referencedVolumeId) {
        console.error(
          'commandsModule::getTotalLesionGlycolysis:No referencedVolumeId found'
        );
      }

      const ptVolume = cs.cache.getVolume(referencedVolumeId);
      const mergedLabelData = mergedLabelmap.scalarData;

      if (mergedLabelData.length !== ptVolume.scalarData.length) {
        console.error(
          'commandsModule::getTotalLesionGlycolysis:Labelmap and ptVolume are not the same size'
        );
      }

      let suv = 0;
      let totalLesionVoxelCount = 0;
      for (let i = 0; i < mergedLabelData.length; i++) {
        // if not background
        if (mergedLabelData[i] !== 0) {
          suv += ptVolume.scalarData[i];
          totalLesionVoxelCount += 1;
        }
      }

      // Average SUV for the merged labelmap
      const averageSuv = suv / totalLesionVoxelCount;

      // total Lesion Glycolysis [suv * ml]
      return (
        averageSuv *
        totalLesionVoxelCount *
        spacing[0] *
        spacing[1] *
        spacing[2] *
        1e-3
      );
    },

    setStartSliceForROIThresholdTool: () => {
      const { viewport } = _getActiveViewportsEnabledElement();
      const { focalPoint, viewPlaneNormal } = viewport.getCamera();

      const selectedAnnotationUIDs = csTools.annotation.selection.getAnnotationsSelectedByToolName(
        RECTANGLE_ROI_THRESHOLD_MANUAL
      );

      const annotationUID = selectedAnnotationUIDs[0];

      const annotation = csTools.annotation.state.getAnnotation(annotationUID);

      const { handles } = annotation.data;
      const { points } = handles;

      // get the current slice Index
      const sliceIndex = viewport.getCurrentImageIdIndex();
      annotation.data.startSlice = sliceIndex;

      // distance between camera focal point and each point on the rectangle
      const newPoints = points.map(point => {
        const distance = vec3.create();
        vec3.subtract(distance, focalPoint, point);
        // distance in the direction of the viewPlaneNormal
        const distanceInViewPlane = vec3.dot(distance, viewPlaneNormal);
        // new point is current point minus distanceInViewPlane
        const newPoint = vec3.create();
        vec3.scaleAndAdd(newPoint, point, viewPlaneNormal, distanceInViewPlane);

        return newPoint;
        //
      });

      handles.points = newPoints;
      // IMPORTANT: invalidate the toolData for the cached stat to get updated
      // and re-calculate the projection points
      annotation.invalidated = true;
      viewport.render();
    },
    setEndSliceForROIThresholdTool: () => {
      const { viewport } = _getActiveViewportsEnabledElement();

      const selectedAnnotationUIDs = csTools.annotation.selection.getAnnotationsSelectedByToolName(
        RECTANGLE_ROI_THRESHOLD_MANUAL
      );

      const annotationUID = selectedAnnotationUIDs[0];

      const annotation = csTools.annotation.state.getAnnotation(annotationUID);

      // get the current slice Index
      const sliceIndex = viewport.getCurrentImageIdIndex();
      annotation.data.endSlice = sliceIndex;

      // IMPORTANT: invalidate the toolData for the cached stat to get updated
      // and re-calculate the projection points
      annotation.invalidated = true;

      viewport.render();
    },
    createTMTVRTReport: () => {
      // get all Rectangle ROI annotation
      const stateManager = csTools.annotation.state.getDefaultAnnotationManager();

      const annotations = [];

      Object.keys(stateManager.annotations).forEach(frameOfReferenceUID => {
        const forAnnotations = stateManager.annotations[frameOfReferenceUID];
        const ROIAnnotations = forAnnotations[RECTANGLE_ROI_THRESHOLD_MANUAL];
        annotations.push(...ROIAnnotations);
      });

      commandsManager.runCommand('exportRTReportForAnnotations', {
        annotations,
      });
    },
    getSegmentationCSVReport: ({ segmentations }) => {
      if (!segmentations || !segmentations.length) {
        segmentations = SegmentationService.getSegmentations();
      }

      let report = {};

      for (const segmentation of segmentations) {
        const { id, label, data } = segmentation;

        const segReport = { id, label };

        if (!data) {
          report[id] = segReport;
          continue;
        }

        Object.keys(data).forEach(key => {
          if (typeof data[key] !== 'object') {
            segReport[key] = data[key];
          } else {
            Object.keys(data[key]).forEach(subKey => {
              const newKey = `${key}_${subKey}`;
              segReport[newKey] = data[key][subKey];
            });
          }
        });

        const labelmapVolume = cornerstone.cache.getVolume(id);

        if (!labelmapVolume) {
          report[id] = segReport;
          continue;
        }

        const referencedVolumeId = labelmapVolume.referencedVolumeId;
        segReport.referencedVolumeId = referencedVolumeId;

        const referencedVolume = cornerstone.cache.getVolume(
          referencedVolumeId
        );

        if (!referencedVolume) {
          report[id] = segReport;
          continue;
        }

        if (!referencedVolume.imageIds || !referencedVolume.imageIds.length) {
          report[id] = segReport;
          continue;
        }

        const firstImageId = referencedVolume.imageIds[0];
        const instance = OHIF.classes.MetadataProvider.get(
          'instance',
          firstImageId
        );

        if (!instance) {
          report[id] = segReport;
          continue;
        }

        report[id] = {
          ...segReport,
          PatientID: instance.PatientID,
          PatientName: instance.PatientName.Alphabetic,
          StudyInstanceUID: instance.StudyInstanceUID,
          SeriesInstanceUID: instance.SeriesInstanceUID,
          StudyDate: instance.StudyDate,
        };
      }

      return report;
    },
    exportRTReportForAnnotations: ({ annotations }) => {
      dicomRTAnnotationExport(annotations);
    },
    setFusionPTColormap: ({ toolGroupId, colormap }) => {
      const toolGroup = ToolGroupService.getToolGroup(toolGroupId);

      const ptDisplaySet = actions.getMatchingPTDisplaySet();

      if (!ptDisplaySet) {
        return;
      }

      const fusionViewportIds = toolGroup.getViewportIds();

      let viewports = [];
      fusionViewportIds.forEach(viewportId => {
        const viewportInfo = CornerstoneViewportService.getViewportInfo(
          viewportId
        );

        const viewportIndex = viewportInfo.getViewportIndex();
        commandsManager.runCommand('setViewportColormap', {
          viewportIndex,
          displaySetInstanceUID: ptDisplaySet.displaySetInstanceUID,
          colormap,
        });

        viewports.push(
          CornerstoneViewportService.getCornerstoneViewport(viewportId)
        );
      });

      viewports.forEach(viewport => {
        viewport.render();
      });
    },
  };

  const definitions = {
    setEndSliceForROIThresholdTool: {
      commandFn: actions.setEndSliceForROIThresholdTool,
      storeContexts: [],
      options: {},
    },
    setStartSliceForROIThresholdTool: {
      commandFn: actions.setStartSliceForROIThresholdTool,
      storeContexts: [],
      options: {},
    },
    getMatchingPTDisplaySet: {
      commandFn: actions.getMatchingPTDisplaySet,
      storeContexts: [],
      options: {},
    },
    getPTMetadata: {
      commandFn: actions.getPTMetadata,
      storeContexts: [],
      options: {},
    },
    createNewLabelmapFromPT: {
      commandFn: actions.createNewLabelmapFromPT,
      storeContexts: [],
      options: {},
    },
    setSegmentationActiveForToolGroups: {
      commandFn: actions.setSegmentationActiveForToolGroups,
      storeContexts: [],
      options: {},
    },
    thresholdSegmentationByRectangleROITool: {
      commandFn: actions.thresholdSegmentationByRectangleROITool,
      storeContexts: [],
      options: {},
    },
    toggleSegmentationVisibility: {
      commandFn: actions.toggleSegmentationVisibility,
      storeContexts: [],
      options: {},
    },
    getTotalLesionGlycolysis: {
      commandFn: actions.getTotalLesionGlycolysis,
      storeContexts: [],
      options: {},
    },
    calculateSuvPeak: {
      commandFn: actions.calculateSuvPeak,
      storeContexts: [],
      options: {},
    },
    getLesionStats: {
      commandFn: actions.getLesionStats,
      storeContexts: [],
      options: {},
    },
    calculateTMTV: {
      commandFn: actions.calculateTMTV,
      storeContexts: [],
      options: {},
    },
    exportTMTVReportCSV: {
      commandFn: actions.exportTMTVReportCSV,
      storeContexts: [],
      options: {},
    },
    createTMTVRTReport: {
      commandFn: actions.createTMTVRTReport,
      storeContexts: [],
      options: {},
    },
    getSegmentationCSVReport: {
      commandFn: actions.getSegmentationCSVReport,
      storeContexts: [],
      options: {},
    },
    exportRTReportForAnnotations: {
      commandFn: actions.exportRTReportForAnnotations,
      storeContexts: [],
      options: {},
    },
    setFusionPTColormap: {
      commandFn: actions.setFusionPTColormap,
      storeContexts: [],
      options: {},
    },
  };

  return {
    actions,
    definitions,
    defaultContext: 'TMTV:CORNERSTONE',
  };
};

export default commandsModule;