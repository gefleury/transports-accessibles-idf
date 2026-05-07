import folium
import geopandas as gpd
import shapely


class GeoPlotter:
    def __init__(self, gdf, geom_col="geom", tiles="OpenStreetMap", zoom_start=10):
        """
        Initialize the GeoPlotter instance by centering the map around gdf data

        Args:
            gdf (GeoDataFrame): The GeoDataFrame to plot
            geom_col (str): The name of the column containing geometry data.
        """
        self.gdf = gdf.copy()
        self.geom_col = geom_col

        # # Compute centroids of the geometries
        # # Use RGF93 Lambert 93 (EPSG: 2154) for metropolitan France
        # # ... Check the geometry column has epsg=2154
        # self.gdf.set_crs(epsg=2154, inplace=True)
        # centroids = self.gdf[self.geom_col].centroid
        # # Reproject the GeoDataFrame and centroids back to EPSG:4326 for Folium
        # self.gdf = self.gdf.to_crs(epsg=4326)
        # centroids = centroids.to_crs(epsg=4326)

        # Ensure original CRS is EPSG:4326
        if self.gdf.crs is None:
            raise ValueError("GeoDataFrame must have a CRS defined")

        if self.gdf.crs.to_epsg() != 4326:
            self.gdf = self.gdf.to_crs(epsg=4326)

        # Project to Lambert-93 for centroid computation for metropolitan France
        gdf_l93 = self.gdf.to_crs(epsg=2154)

        centroids_l93 = gdf_l93[self.geom_col].centroid

        # Back to EPSG:4326 for Folium
        centroids = centroids_l93.to_crs(epsg=4326)

        # Create a Folium map centered around the data's approximate center.
        self.map_location = [centroids.y.mean(), centroids.x.mean()]
        self.map = folium.Map(location=self.map_location, zoom_start=zoom_start, tiles=tiles)

    def add_geodata_to_map(
        self,
        default_color="blue",
        color_col=None,
        colormap=None,
        tooltip_cols=None,
        tooltip_html=None,
        **kwargs,
    ):
        """
        Add geometries from the GeoDataFrame self.gdf to the Folium map.

        Args:
            default_color (str): Default color if color_col is missing.
            color_col (str): Name of the column of self.gdf used to define colors
            colormap (dict or callable): A dictionary mapping 'color_col' values to colors
                                         or a function that maps values to colors.
            tooltip_cols (list of str): List of column names to be displayed in the tooltip.
            tooltip_html (callable): Optional callable (row) -> HTML string. When provided,
                                     overrides tooltip_cols and gives full control over the
                                     tooltip content.
            **kwargs : Other Folium styling parameters.
        """

        for _, row in self.gdf.iterrows():
            geom = row[self.geom_col]

            if not hasattr(geom, "geom_type"):
                continue

            # Set color
            if not color_col:
                color = default_color
            else:
                color_code = row[color_col]
                if colormap:
                    if callable(colormap):
                        color = colormap(color_code)
                    elif isinstance(colormap, dict):
                        color = colormap.get(color_code, default_color)
                    else:
                        raise ValueError("Colormap must be a function or dictionary")
                else:
                    raise ValueError("Colormap is missing")

            # Create Tooltip content
            if tooltip_html is not None:
                tooltip_text = tooltip_html(row)
            else:
                tooltip_cols = (
                    [x for x in self.gdf.columns if x != self.geom_col]
                    if not tooltip_cols
                    else tooltip_cols
                )
                assert isinstance(tooltip_cols, list)
                tooltip_text = "<br>".join(
                    [f"<b>{col}:</b> {row[col]}" for col in tooltip_cols if col in row]
                )

            self.add_geometry_element(
                geom, color=color, tooltip_text=tooltip_text, **kwargs
            )

    def add_geodata_from_gdf_to_map(
        self,
        gdf: gpd.GeoDataFrame,
        geom_col="geom",
        default_color="blue",
        color_col=None,
        colormap=None,
        tooltip_cols=None,
        tooltip_html=None,
        **kwargs,
    ):
        """
        Add geometries from the GeoDataFrame gdf to the Folium map.
        """
        self.gdf, original_gdf = gdf, self.gdf
        self.geom_col, original_geom_col = geom_col, self.geom_col
        self.add_geodata_to_map(
            default_color=default_color,
            color_col=color_col,
            colormap=colormap,
            tooltip_cols=tooltip_cols,
            tooltip_html=tooltip_html,
            **kwargs,
        )
        self.gdf, self.geom_col = original_gdf, original_geom_col

    def add_linestring(
        self, line: shapely.geometry.LineString, tooltip_text=None, **kwargs
    ):
        line_coords = [(coord[1], coord[0]) for coord in line.coords]
        folium.PolyLine(
            locations=line_coords,
            tooltip=folium.Tooltip(tooltip_text) if tooltip_text else None,
            **kwargs,
        ).add_to(self.map)

    def add_multilinestring(
        self, lines: shapely.geometry.MultiLineString, tooltip_text=None, **kwargs
    ):
        for line in lines.geoms:
            self.add_linestring(line, tooltip_text=tooltip_text, **kwargs)

    def add_point(self, point: shapely.geometry.Point, tooltip_text=None, **kwargs):
        coords = (point.y, point.x)
        folium.CircleMarker(
            location=coords,
            tooltip=folium.Tooltip(tooltip_text) if tooltip_text else None,
            **kwargs,
        ).add_to(self.map)

    def add_multipoint(
        self, points: shapely.geometry.MultiPoint, tooltip_text=None, **kwargs
    ):
        for point in points.geoms:
            self.add_point(point, tooltip_text=tooltip_text, **kwargs)

    def add_polygon(
        self, polygon: shapely.geometry.Polygon, tooltip_text=None, **kwargs
    ):
        """Add a 2D (or 3D) Polygon to the map (by removing Z if exists)."""
        exterior_coords = [(pt[1], pt[0]) for pt in polygon.exterior.coords]
        interiors = [
            [(pt[1], pt[0]) for pt in interior.coords] for interior in polygon.interiors
        ]

        folium.Polygon(
            locations=[exterior_coords] + interiors,
            tooltip=folium.Tooltip(tooltip_text) if tooltip_text else None,
            **kwargs,
        ).add_to(self.map)

    def add_multipolygon(
        self, multipolygon: shapely.geometry.MultiPolygon, tooltip_text=None, **kwargs
    ):
        """Add a 2D (or 3D) MultiPolygon to the map (by removing Z if exists)."""
        for polygon in multipolygon.geoms:
            self.add_polygon(polygon, tooltip_text=tooltip_text, **kwargs)

    @staticmethod
    def flatten_to_2d(geom):
        """Convert 3D geometries to 2D by dropping Z"""
        if hasattr(geom, "has_z") and geom.has_z:
            return shapely.geometry.shape(shapely.geometry.mapping(geom))
        return geom

    def add_geometry_element(self, geom, tooltip_text=None, **kwargs):
        """
        Add a geometry element (Point, LineString, MultiLineString, etc.) to the Folium map.

        Args:
            geom: The geometry to add.
            tooltip_text (str, optional): The text to display in the tooltip on hover.
            **kwargs: Additional Folium styling options.
        """
        geom = GeoPlotter.flatten_to_2d(geom)

        if geom.geom_type == "LineString":
            self.add_linestring(geom, tooltip_text=tooltip_text, **kwargs)
        elif geom.geom_type == "MultiLineString":
            self.add_multilinestring(geom, tooltip_text=tooltip_text, **kwargs)
        elif geom.geom_type == "Point":
            self.add_point(geom, tooltip_text=tooltip_text, **kwargs)
        elif geom.geom_type == "MultiPoint":
            self.add_multipoint(geom, tooltip_text=tooltip_text, **kwargs)
        elif geom.geom_type == "Polygon":
            self.add_polygon(geom, tooltip_text=tooltip_text, **kwargs)
        elif geom.geom_type == "MultiPolygon":
            self.add_multipolygon(geom, tooltip_text=tooltip_text, **kwargs)
        elif geom.geom_type == "GeometryCollection":
            self.add_geometrycollection(geom, tooltip_text=tooltip_text, **kwargs)
        else:
            raise ValueError(f"Unknown geometry type: {geom.geom_type}")

    def add_geometrycollection(
        self, geoms: shapely.geometry.GeometryCollection, tooltip_text=None, **kwargs
    ):
        for sub_geom in geoms.geoms:
            self.add_geometry_element(sub_geom, tooltip_text=tooltip_text, **kwargs)
