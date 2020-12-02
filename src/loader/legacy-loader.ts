import { PieContent, PieItemElement } from "../interface";
import { getPackageBundleUri, getPackageWithoutVersion } from "../utils/utils";

import isFunction from "lodash/isFunction";
import pickBy from "lodash/pickBy";
import { emptyConfigure } from "../components/empty-configure";
import {
  BundleEndpoints,
  BundleType,
  Entry,
  LoadedElementsQuery,
  LoadedElementsResp,
  LoadOpts,
  PieLoader,
  Status,
} from "./pie-loader";

/**
 * TODO: Clean up: PD-761
 */
const DEFAULT_ENDPOINTS = {
  prod: {
    bundleBase: "https://pits-cdn.pie-api.io//bundles/",
    buildServiceBase: "https://pits-dot-pie-prod-221718.appspot.com/bundles/",
  },
  stage: {
    bundleBase: "https://pits-cdn-staging.pie-api.io/bundles/",
    buildServiceBase:
      "https://pits-dot-pie-staging-221718.appspot.com/bundles/",
  },
  dev: {
    bundleBase: "https://pits-cdn-dev.pie-api.io/bundles/",
    buildServiceBase: "https://pits-dot-pie-dev-221718.appspot.com/bundles/",
  },
};

export const needToLoad = (registry: any, bundle: BundleType) => (
  el: string,
  key: string
): boolean => {
  if (!registry) {
    return true;
  }
  const regEntry: Entry = registry[key];

  if (!regEntry) {
    return true;
  }

  const { config, controller, element } = regEntry;
  switch (bundle) {
    case BundleType.editor:
      return !config || !controller || !element;
    case BundleType.clientPlayer:
      return !controller || !element;
    case BundleType.player:
      return !element;
    default:
      true;
  }
};
/**
 * Given a defintion of elements, will check the registry
 * and return the elements and tags that need to be loaded.
 *
 * @param elements - the elements to test against registry
 */
export const getElementsToLoad = (
  els: PieItemElement,
  bundle: BundleType = BundleType.editor,
  registry
): PieItemElement => {
  return pickBy(els, needToLoad(registry, bundle));
};

/**
 * Pie Registry contols the loading of all PIEs from the pie build service
 */
export class LegacyPieLoader implements PieLoader {
  endpoints: BundleEndpoints;

  /**
   * Create a PieLoader instance
   * Can provide config object for endpoints, will default to to production environment preset.
   * @param endpoints an object providing {bundleBase, buildServiceBase} endpoints
   */
  constructor(_endpoints?: BundleEndpoints) {
    if (!_endpoints) {
      this.endpoints = DEFAULT_ENDPOINTS.stage;
    } else {
      this.endpoints = _endpoints;
    }
    // read from global in case >1 instance loaded.
    window["PIE_REGISTRY"] = window["PIE_REGISTRY"]
      ? window["PIE_REGISTRY"]
      : {};
    LegacyPieLoader._registry = window["PIE_REGISTRY"];
    this.registry = LegacyPieLoader._registry;
  }

  private static _registry: { [elementName: string]: Entry };
  protected registry: { [elementName: string]: Entry };

  public getController = (pieTagName: string) => {
    return this.registry[pieTagName]
      ? this.registry[pieTagName].controller
      : null;
  };

  public elementsHaveLoaded = (
    els: LoadedElementsQuery[]
  ): Promise<LoadedElementsResp> => {
    const promises = els.map((el) => customElements.whenDefined(el.tag));

    return Promise.all(promises)
      .then(() => {
        return Promise.resolve({ elements: els, val: true });
      })
      .catch(() => {
        return Promise.resolve({ elements: els, val: false });
      });
  };

  public load(content: PieContent, opts: LoadOpts): Promise<void> {
    return this.loadCloudPies({ doc: window.document, content, ...opts });
  }

  /**
   *
   * @param {Object<string,string>} elements elements to load from pie cloud service
   * @param {HTMLDocument} doc - the document to load the scripts
   * @param {string} base_url - default base url for cloud service
   */
  public loadCloudPies = async (options: {
    content: PieContent;
    doc: Document;
    endpoints?: BundleEndpoints;
    bundle?: BundleType;
    useCdn: boolean;
  }) => {
    console.log("loadCloudPies...");
    if (!options.endpoints) {
      options.endpoints = this.endpoints;
    }
    if (!options.bundle) {
      options.bundle = BundleType.editor;
    }

    console.log("loadCloudPies...");
    const elements = options.content.elements;
    let head: HTMLElement = options.doc.getElementsByTagName("head")[0];
    if (!head) {
      head = options.doc.createElement("head");
      options.doc.appendChild(head);
    }
    const piesToLoad = getElementsToLoad(
      elements,
      options.bundle,
      this.registry
    );
    let scriptUrl;

    if (options.content.bundle && options.content.bundle.url) {
      scriptUrl = options.content.bundle.url;
    } else if (
      options.useCdn &&
      options.content.bundle &&
      options.content.bundle.hash
    ) {
      scriptUrl =
        options.endpoints.bundleBase +
        options.content.bundle.hash +
        "/" +
        options.bundle;
    } else {
      const bundleUri = getPackageBundleUri(piesToLoad);
      if (!bundleUri) {
        return;
      }
      scriptUrl =
        options.endpoints.buildServiceBase + bundleUri + "/" + options.bundle;
    }

    const loadedScripts = [...head.getElementsByTagName("script")];
    if (
      loadedScripts.find((s) => {
        return s.src === scriptUrl;
      })
    ) {
      return;
    }

    const script = options.doc.createElement("script");

    const onloadFn = ((_pies) => {
      return () => {
        const pieKeys = Object.keys(_pies);

        console.log("onload!");
        pieKeys.forEach((key) => {
          const packagesWithoutVersion = getPackageWithoutVersion(_pies[key]);
          const pie =
            window["pie"] && window["pie"].default
              ? window["pie"].default[packagesWithoutVersion]
              : null;
          if (!pie) {
            console.log(`pie constructor not found for ${key}`);
            return;
          }
          const elName = key;
          if (!customElements.get(elName)) {
            customElements.define(elName, pie.Element);
            this.registry[elName] = {
              package: _pies[key],
              status: Status.loading,
              tagName: elName,
            };

            customElements.whenDefined(elName).then(() => {
              console.log("DEFINED:", elName);
              this.registry[elName].status = Status.loaded;
              this.registry[elName].element = customElements.get(elName);
              this.registry[elName].controller = pie.controller;
            });
          }

          if (options.bundle === BundleType.editor) {
            // This fixes some cases where the pie build service fails
            pie.Configure = isFunction(pie.Configure)
              ? pie.Configure
              : emptyConfigure(elName);

            const configElName = elName + "-config";

            if (!customElements.get(configElName)) {
              customElements.define(configElName, pie.Configure);
              customElements.whenDefined(configElName).then(() => {
                console.log("DEFINED:", elName);
                if (this.registry[elName]) {
                  this.registry[elName].config = customElements.get(
                    configElName
                  );
                }
              });
            }
          }
        });
      };
    })(piesToLoad);

    script.onload = onloadFn;
    script.src = scriptUrl;
    head.appendChild(script);
  };
}