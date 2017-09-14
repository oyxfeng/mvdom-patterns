// This still use the "./lib" module to load the required library, making "./lib" the single point for external libraries.
import { View } from "mvdom"
import { render } from "./ts/render";

export class BaseView implements View {
	/** Unique id of the view. Used in namespace binding and such.  */
	id: string;

	/** The view name or "class name". */
	name: string;

	/** The htmlElement created */
	el?: HTMLElement;

	create(data?: any) {
		return render(this.name, data);
	}
}